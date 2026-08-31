import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackgroundRuntime } from "./runtime.ts";

const HANDOFF_MS = 10 * 60_000;
const HANDOFF_SHORTCUT = "alt+h";

const HANDOFF_GUIDELINE =
	"When a command moves to a background task, continue independent work or check why it is taking long with background_task action=read; completion is delivered as steering at the next turn boundary. Never run sleep command to wait. Never use the timeout shell command.";

const HANDOFF_DESCRIPTION = `Execute a bash command in the current working directory. Commands stay in the foreground for up to 10 minutes, then continue as a background task. timeout, if set, covers the command's total foreground and background runtime; there is no default timeout. Don't use the timeout shell command to limit it. Completion arrives as a steering message at the next turn. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; if truncated, the full output is in a temp file.`;

const hybridBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: "Total command timeout in seconds across foreground and background execution. Optional.",
		}),
	),
});

/** Session env for spawned commands: pi's managed bin dir on PATH plus PI_* session metadata. */
export function buildSessionEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const binDir = join(getAgentDir(), "bin");
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[pathKey]: hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter),
	};
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	const model = ctx.model;
	if (model) {
		env.PI_PROVIDER = model.provider;
		env.PI_MODEL = model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function createHybridBashDefinition(cwd: string, runtime: BackgroundRuntime, foreground: Map<string, AbortController>) {
	const operations: BashOperations = {
		async exec(command, execCwd, { onData, signal, timeout, env }) {
			try {
				await fsAccess(execCwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${execCwd}\nCannot execute bash commands.`);
			}
			const task = runtime.start(command, execCwd, {
				notify: false,
				env,
				onOutputRaw: onData,
				timeout,
			});
			const handoff = new AbortController();
			foreground.set(task.id, handoff);
			const done = await runtime.waitForExit(task.id, HANDOFF_MS, signal, handoff.signal);
			foreground.delete(task.id);
			if (!done) {
				if (!handoff.signal.aborted && signal?.aborted) {
					runtime.discard(task.id);
					throw new Error("aborted");
				}
				if (!runtime.promote(task.id)) {
					const snapshot = runtime.get(task.id);
					runtime.discard(task.id);
					return { exitCode: snapshot?.exitCode ?? null };
				}
				const timeoutNote = timeout === undefined ? "" : ` timeout ${timeout}s from command start.`;
				const reason = handoff.signal.aborted
					? `Handoff requested with ${HANDOFF_SHORTCUT}`
					: "Command still running after 10 minutes";
				onData(
					Buffer.from(
						`\n\n${reason}; moved to background task ${task.id}.${timeoutNote} Completion is delivered as steering at the next turn boundary; Never run sleep command to wait. Inspect output meanwhile with background_task action=read id=${task.id}.`,
					),
				);
				return { exitCode: null };
			}
			runtime.discard(task.id);
			return { exitCode: done.task.exitCode };
		},
	};

	const definition = createBashToolDefinition(cwd, { operations });
	const renderResult = definition.renderResult;
	if (!renderResult) throw new Error("Bash tool result renderer is unavailable");
	const renderHandoffResult: typeof renderResult = (result, options, theme, context) => {
		const displayResult =
			options.isPartial && (context.args.timeout ?? 0) >= 60
				? {
						...result,
						content: [
							...result.content,
							{ type: "text" as const, text: `\n[${HANDOFF_SHORTCUT} to run in background]` },
						],
					}
				: result;
		return renderResult(displayResult, options, theme, context);
	};
	return {
		...definition,
		description: HANDOFF_DESCRIPTION,
		parameters: hybridBashSchema,
		renderResult: renderHandoffResult,
		promptGuidelines: [...(definition.promptGuidelines ?? []), HANDOFF_GUIDELINE],
	};
}

export function registerHybridBash(pi: ExtensionAPI, runtime: BackgroundRuntime): void {
	const foreground = new Map<string, AbortController>();

	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(createHybridBashDefinition(ctx.cwd, runtime, foreground));
	});

	pi.registerShortcut(HANDOFF_SHORTCUT, {
		description: "Move the most recent foreground bash command to the background",
		handler: async (ctx) => {
			for (const [id, controller] of [...foreground.entries()].reverse()) {
				if (controller.signal.aborted || runtime.get(id)?.status !== "running") {
					foreground.delete(id);
					continue;
				}
				controller.abort();
				ctx.ui.notify(`Moving ${id} to the background.`, "info");
				return;
			}
			ctx.ui.notify("No foreground bash command is running.", "warning");
		},
	});
}
