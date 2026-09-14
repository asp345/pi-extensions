import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FALLBACK_CONTINUATION,
	finalError,
	lastAssistantText,
	remainingModels,
	resolveModel,
	resolveModels,
	resolveThinking,
	turnLimitAction,
} from "./fallback.ts";
import { buildParentTranscriptText } from "./fork.ts";
import { buildSystemPrompt } from "./resources.ts";
import { REPORT_TOOL_NAME, type RpcMessage, type RpcProcess, spawnRpcProcess } from "./rpc.ts";
import type { AgentDefinition, RunRequest, ThinkingLevel } from "./types.ts";
import { contentText, message, onAbort } from "./util.ts";

export interface RpcCallbacks {
	onSession(proc: RpcProcess, info: { sessionFile?: string; model?: string; thinking?: ThinkingLevel }): void;
	onMessages(messages: RpcMessage[]): void;
	onFallback(model: Model<Api>, reason: string): void;
	onText(text: string): void;
	onTurn(): void;
	onTool(name: string): void;
	onReport(summary: string): void;
}

export interface RunResult {
	proc: RpcProcess;
	text: string;
	error?: string;
	messages: RpcMessage[];
	sessionFile?: string;
	model?: string;
}

export interface ResumeRequest {
	id: string;
	cwd: string;
	sessionFile?: string;
	definition: AgentDefinition;
	prompt: string;
	models: string[];
	model?: Model<Api>;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	signal?: AbortSignal;
}

const REPORT_EXTENSION_PATH = fileURLToPath(new URL("./report-tool.ts", import.meta.url));
const TURN_LIMIT_STEER = "You reached the configured turn limit. Give your final answer now without more tool calls.";
const MESSAGE_POLL_MS = 1_000;

export async function runNew(ctx: ExtensionContext, request: RunRequest, callbacks: RpcCallbacks): Promise<RunResult> {
	const definition = request.definition;
	if (request.parentSignal?.aborted) throw new Error("Subagent cancelled before session setup.");
	const cwd = request.worktree?.cwd ?? request.cwd;
	const modelNames = request.model ? [request.model, ...definition.models] : definition.models;
	const models = () => resolveModels(modelNames.length ? modelNames : ["parent"], ctx, definition);
	const initial = models()[0];
	if (!initial) throw new Error(`Agent configuration error in ${definition.path}: no configured model is available.`);
	const preferredName = modelNames[0] ?? "parent";
	try {
		resolveModel(preferredName, ctx, definition);
	} catch {
		callbacks.onFallback(initial, `Higher-priority model ${preferredName} is unavailable.`);
	}
	const thinking = resolveThinking(definition.thinking, ctx);
	const systemPrompt = buildSystemPrompt(definition, ctx, cwd);
	const prompt = request.fork ? withParentTranscript(request.prompt, buildParentTranscriptText(ctx)) : request.prompt;
	const proc = await spawnRpcProcess({
		cwd,
		args: buildChildArgs(ctx, definition, cwd, { model: initial, thinking, systemPrompt }),
	});
	let sessionFile: string | undefined;
	try {
		await proc.setSessionName(`${definition.name}#${request.id.slice(0, 8)}`);
	} catch {}
	try {
		sessionFile = (await proc.getState()).sessionFile;
	} catch {}
	callbacks.onSession(proc, { sessionFile, model: `${initial.provider}/${initial.id}`, thinking });
	const outcome = await driveRun(proc, prompt, {
		models,
		maxTurns: request.maxTurns ?? definition.maxTurns,
		signal: request.parentSignal,
		callbacks,
	});
	const messages = await safeMessages(proc);
	callbacks.onMessages(messages);
	try {
		sessionFile = (await proc.getState()).sessionFile ?? sessionFile;
	} catch {}
	return {
		proc,
		text: outcome.text,
		error: outcome.error,
		messages,
		sessionFile,
		model: outcome.model ?? `${initial.provider}/${initial.id}`,
	};
}

export async function resumeProc(
	proc: RpcProcess | undefined,
	ctx: ExtensionContext,
	request: ResumeRequest,
	callbacks: RpcCallbacks,
): Promise<RunResult> {
	const live = proc && !proc.closed ? proc : undefined;
	if (!live && !request.sessionFile) {
		return runNew(
			ctx,
			{
				id: request.id,
				definition: request.definition,
				prompt: request.prompt,
				maxTurns: request.maxTurns,
				fork: false,
				cwd: request.cwd,
				parentSignal: request.signal,
			},
			callbacks,
		);
	}
	const definition = request.definition;
	let active: RpcProcess;
	if (live) {
		active = live;
	} else {
		active = await spawnRpcProcess({
			cwd: request.cwd,
			args: buildChildArgs(ctx, definition, request.cwd, {
				systemPrompt: buildSystemPrompt(definition, ctx, request.cwd),
				sessionFile: request.sessionFile,
			}),
		});
		callbacks.onSession(active, { sessionFile: request.sessionFile });
	}
	if (request.signal?.aborted) {
		const messages = await safeMessages(active);
		return { proc: active, text: "", messages, sessionFile: request.sessionFile };
	}
	if (request.model) {
		const targets = [
			request.model,
			...remainingModels(request.model, () => resolveModels(request.models, ctx, definition)),
		];
		let applied = false;
		let lastError = "";
		for (const [index, target] of targets.entries()) {
			try {
				await active.setModel(target.provider, target.id);
				if (index > 0) callbacks.onFallback(target, lastError);
				applied = true;
				break;
			} catch (error) {
				lastError = message(error);
			}
		}
		if (!applied) throw new Error(lastError || "Subagent model is unavailable.");
	}
	if (request.thinking) {
		try {
			await active.setThinkingLevel(request.thinking);
		} catch {}
	}
	const outcome = await driveRun(active, request.prompt, {
		models: request.models.length ? () => resolveModels(request.models, ctx, definition) : undefined,
		maxTurns: request.maxTurns ?? definition.maxTurns,
		signal: request.signal,
		callbacks,
	});
	const messages = await safeMessages(active);
	callbacks.onMessages(messages);
	let sessionFile = request.sessionFile;
	let model = request.model ? `${request.model.provider}/${request.model.id}` : undefined;
	try {
		const state = await active.getState();
		sessionFile = state.sessionFile ?? sessionFile;
		if (state.model) model = `${state.model.provider}/${state.model.id}`;
	} catch {}
	if (outcome.model) model = outcome.model;
	return { proc: active, text: outcome.text, error: outcome.error, messages, sessionFile, model };
}

export {
	finalError,
	lastAssistantText,
	resolveModel,
	resolveModels,
	resolveThinking,
	turnLimitAction,
} from "./fallback.ts";

interface DriveOptions {
	models?: () => Model<Api>[];
	maxTurns?: number;
	signal?: AbortSignal;
	callbacks: RpcCallbacks;
}

interface DriveOutcome {
	text: string;
	error?: string;
	aborted: boolean;
	model?: string;
}

export async function driveRun(proc: RpcProcess, prompt: string, options: DriveOptions): Promise<DriveOutcome> {
	const { callbacks, signal } = options;
	let turns = 0;
	let current = "";
	let wrapping = false;
	const unsubscribe = proc.onEvent((event) => {
		const type = event.type;
		if (type === "message_start") {
			const role = (event.message as { role?: unknown } | undefined)?.role;
			if (role === "assistant") current = "";
		} else if (type === "message_update") {
			const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				current += update.delta;
				callbacks.onText(current);
			}
		} else if (type === "message_end") {
			const assistant = event.message as { role?: unknown; content?: unknown } | undefined;
			if (assistant?.role === "assistant") {
				const text = contentText(assistant.content).trim();
				if (text) {
					current = text;
					callbacks.onText(current);
				}
			}
		} else if (type === "tool_execution_start") {
			if (event.toolName === REPORT_TOOL_NAME) {
				const summary = (event.args as { summary?: unknown } | undefined)?.summary;
				if (typeof summary === "string" && summary.trim()) callbacks.onReport(summary.trim().slice(0, 4_000));
			}
		} else if (type === "tool_execution_end") {
			callbacks.onTool(typeof event.toolName === "string" ? event.toolName : "tool");
		} else if (type === "turn_end") {
			turns += 1;
			callbacks.onTurn();
			const action = turnLimitAction(turns, options.maxTurns, wrapping, signal?.aborted === true);
			if (action === "warn") {
				wrapping = true;
				void proc.steer(TURN_LIMIT_STEER).catch(() => undefined);
			} else if (action === "abort") {
				void proc.abort().catch(() => undefined);
			}
		}
	});
	const stopPoll = startMessagePoll(proc, callbacks);
	try {
		const first = await runAttempt(proc, prompt, signal);
		let messages = await safeMessages(proc);
		let model = await currentModelName(proc);
		if (first.aborted || signal?.aborted) return { text: lastAssistantText(messages), aborted: true, model };
		let currentError = first.error ?? finalError(messages);
		if (!currentError) return { text: lastAssistantText(messages), aborted: false, model };
		const failures = [`Primary model failed: ${currentError}`];
		for (const fallback of remainingModels(modelRef(model), options.models)) {
			const name = `${fallback.provider}/${fallback.id}`;
			try {
				const applied = await proc.setModel(fallback.provider, fallback.id);
				model = `${applied.provider}/${applied.id}`;
			} catch (error) {
				failures.push(`Fallback model ${name} failed to initialize: ${message(error)}`);
				continue;
			}
			callbacks.onFallback(fallback, currentError);
			const retry = await runAttempt(proc, FALLBACK_CONTINUATION, signal);
			messages = await safeMessages(proc);
			model = (await currentModelName(proc)) ?? model;
			if (retry.aborted || signal?.aborted) return { text: lastAssistantText(messages), aborted: true, model };
			const retryError = retry.error ?? finalError(messages);
			if (!retryError) return { text: lastAssistantText(messages), aborted: false, model };
			currentError = retryError;
			failures.push(`Fallback model ${model ?? name} failed: ${currentError}`);
		}
		return { text: lastAssistantText(messages), error: failures.join("; "), aborted: false, model };
	} finally {
		unsubscribe();
		stopPoll();
	}
}

async function runAttempt(
	proc: RpcProcess,
	text: string,
	signal?: AbortSignal,
): Promise<{ aborted: boolean; error?: string }> {
	if (signal?.aborted) return { aborted: true };
	try {
		await proc.prompt(text);
	} catch (error) {
		return signal?.aborted ? { aborted: true } : { aborted: false, error: message(error) };
	}
	const detach = onAbort(signal, () => {
		void proc.abort().catch(() => undefined);
	});
	try {
		await proc.waitForIdle();
	} catch (error) {
		return signal?.aborted ? { aborted: true } : { aborted: false, error: message(error) };
	} finally {
		detach();
	}
	if (signal?.aborted) return { aborted: true };
	return { aborted: false };
}

function startMessagePoll(proc: RpcProcess, callbacks: RpcCallbacks): () => void {
	const timer = setInterval(() => {
		void (async () => {
			try {
				callbacks.onMessages(await proc.getMessages());
			} catch {}
		})();
	}, MESSAGE_POLL_MS);
	return () => clearInterval(timer);
}

async function safeMessages(proc: RpcProcess): Promise<RpcMessage[]> {
	try {
		return await proc.getMessages();
	} catch {
		return [];
	}
}

async function currentModelName(proc: RpcProcess): Promise<string | undefined> {
	try {
		const state = await proc.getState();
		return state.model ? `${state.model.provider}/${state.model.id}` : undefined;
	} catch {
		return undefined;
	}
}

function modelRef(name: string | undefined): Model<Api> | undefined {
	if (!name) return undefined;
	const slash = name.indexOf("/");
	if (slash < 0) return undefined;
	return { provider: name.slice(0, slash), id: name.slice(slash + 1) } as Model<Api>;
}

function withParentTranscript(prompt: string, forkText: string): string {
	if (!forkText.trim()) return prompt;
	return `${prompt}\n\n## Parent conversation (read-only reference)\nVerify claims against files you inspect yourself.\n\n${forkText.trim()}`;
}

interface ChildOptions {
	model?: Model<Api>;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	sessionFile?: string;
}

function buildChildArgs(
	ctx: ExtensionContext,
	definition: AgentDefinition,
	cwd: string,
	options: ChildOptions,
): string[] {
	const args: string[] = [];
	if (options.model) args.push("--model", `${options.model.provider}/${options.model.id}`);
	if (options.thinking) args.push("--thinking", options.thinking);
	args.push("--system-prompt", options.systemPrompt);
	const sessionDir = resolveSessionDir(definition.sessionDir, cwd);
	if (sessionDir) args.push("--session-dir", sessionDir);
	if (!definition.persistSession) args.push("--no-session");
	if (options.sessionFile) args.push("--session", options.sessionFile);
	args.push("--tools", [...definition.tools, REPORT_TOOL_NAME].join(","));
	args.push("--extension", REPORT_EXTENSION_PATH);
	args.push("--no-prompt-templates", "--no-themes", "--no-context-files");
	if (definition.skills === false) args.push("--no-skills");
	if (definition.extensions === false) args.push("--no-extensions");
	args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
	return args;
}

function resolveSessionDir(value: string | undefined, cwd: string): string | undefined {
	if (!value) return undefined;
	if (value === "~" || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}
