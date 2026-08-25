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

const DEFAULT_SYNC_MS = 30_000;
const MAX_SYNC_MS = 90_000;

const HANDOFF_GUIDELINE =
	"When a command moves to a background task, continue independent work or check why it is taking long with background_task action=read; completion is delivered as steering at the next turn boundary. Never run sleep command to wait.";

const HANDOFF_DESCRIPTION = `Execute a bash command in the current working directory. Foreground wait is 30s by default (must be 1-90). After that wait the command keeps running as a background task. Completion arrives as a steering message at the next turn. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; if truncated, the full output is in a temp file.`;

const hybridBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 90,
			description:
				"Foreground wait in seconds before handoff to a background task. Default 30. Must be 1-90.",
		}),
	),
});

function resolveWindowMs(timeout: number | undefined): number {
	if (timeout === undefined) return DEFAULT_SYNC_MS;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_SYNC_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_SYNC_MS / 1000} seconds`);
	}
	return timeoutMs;
}

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

function createHybridBashDefinition(cwd: string, runtime: BackgroundRuntime) {
	const operations: BashOperations = {
		async exec(command, execCwd, { onData, signal, timeout, env }) {
			try {
				await fsAccess(execCwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${execCwd}\nCannot execute bash commands.`);
			}
			const windowMs = resolveWindowMs(timeout);
			const task = runtime.start(command, execCwd, {
				notify: false,
				env,
				onOutputRaw: onData,
			});
			const done = await runtime.waitForExit(task.id, windowMs, signal);
			if (!done) {
				if (signal?.aborted) {
					runtime.discard(task.id);
					throw new Error("aborted");
				}
				if (!runtime.promote(task.id)) {
					const snapshot = runtime.get(task.id);
					runtime.discard(task.id);
					return { exitCode: snapshot?.exitCode ?? null };
				}
				onData(
					Buffer.from(
						`\n\nCommand still running after ${Math.round(windowMs / 1000)}s; moved to background task ${task.id}. Completion is delivered as steering at the next turn boundary; Never run sleep command to wait. Inspect output meanwhile with background_task action=read id=${task.id}.`,
					),
				);
				return { exitCode: null };
			}
			runtime.discard(task.id);
			return { exitCode: done.task.exitCode };
		},
	};

	const definition = createBashToolDefinition(cwd, { operations });
	return {
		...definition,
		description: HANDOFF_DESCRIPTION,
		parameters: hybridBashSchema,
		promptGuidelines: [...(definition.promptGuidelines ?? []), HANDOFF_GUIDELINE],
	};
}

export function registerHybridBash(pi: ExtensionAPI, runtime: BackgroundRuntime): void {
	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(createHybridBashDefinition(ctx.cwd, runtime));
	});
}
