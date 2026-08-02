import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	type BashToolDetails,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackgroundRuntime } from "./runtime.js";

const DEFAULT_SYNC_MS = 30_000;
const MAX_SYNC_MS = 120_000;

function appendStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`;
}

export function registerHybridBash(pi: ExtensionAPI, runtime: BackgroundRuntime): void {
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Runs in the foreground for up to 30 seconds (configurable via timeout, capped at 120 seconds); if the command is still running after that window, it automatically continues as a background task instead of being killed, and its completion is delivered as a steering message at the next turn boundary. Returns stdout and stderr truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); when truncated, full output is saved to a temp file.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			"When a command moves to a background task, continue independent work or check why it is taking long with background_task action=read; completion is delivered as steering at the next turn boundary. Do not sleep or poll to wait.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Seconds to run in the foreground before moving the command to a background task (default 30, max 120)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | undefined>> {
			const task = runtime.start(params.command, ctx.cwd, { notify: false });
			onUpdate?.({ content: [], details: undefined });
			const windowMs = Math.min(Math.max(1, params.timeout ?? DEFAULT_SYNC_MS / 1000) * 1000, MAX_SYNC_MS);
			const done = await runtime.waitForExit(task.id, windowMs, signal);
			if (!done) {
				if (signal?.aborted) {
					const text = appendStatus(truncateTail(runtime.output(task.id) ?? "").content, "Command aborted");
					runtime.discard(task.id);
					throw new Error(text);
				}
				if (!runtime.promote(task.id)) {
					return {
						content: [{ type: "text", text: `Command finished but its result is no longer available.` }],
						details: undefined,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Command still running after ${Math.round(windowMs / 1000)}s; moved to background task ${task.id}. Completion is delivered as steering at the next turn boundary; do not sleep or poll to wait. Inspect output meanwhile with background_task action=read id=${task.id}.`,
						},
					],
					details: undefined,
				};
			}
			try {
				const output = done.output;
				const truncation = truncateTail(output);
				let text = truncation.content || "(no output)";
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					const fullOutputPath = join(tmpdir(), `pi-bash-${task.id}.log`);
					writeFileSync(fullOutputPath, output, "utf8");
					details = { truncation, fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLine = output.slice(output.lastIndexOf("\n") + 1);
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(Buffer.byteLength(lastLine))}). Full output: ${fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
					}
				}
				const { exitCode } = done.task;
				if (exitCode !== 0 && exitCode !== null)
					throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
				return { content: [{ type: "text", text }], details };
			} finally {
				runtime.discard(task.id);
			}
		},
	});
}
