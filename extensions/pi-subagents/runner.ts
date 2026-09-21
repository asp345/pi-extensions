import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel, resolveThinking } from "./models.ts";
import { PARENT_ONLY_TOOLS, REPORT_TOOL_NAME, type RpcMessage, type RpcProcess, spawnRpcProcess } from "./rpc.ts";
import { finalError, lastAssistantText } from "./transcript.ts";
import type { RunRequest, ThinkingLevel } from "./types.ts";
import { contentText, message, onAbort } from "./util.ts";

export interface RpcCallbacks {
	onSession(proc: RpcProcess, info: { sessionFile?: string; model?: string; thinking?: ThinkingLevel }): void;
	onMessages(messages: RpcMessage[]): void;
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
	title: string;
	cwd: string;
	sessionFile?: string;
	prompt: string;
	model?: string;
	thinking?: ThinkingLevel;
	signal?: AbortSignal;
}

const REPORT_EXTENSION_PATH = fileURLToPath(new URL("./report-tool.ts", import.meta.url));

export async function runNew(ctx: ExtensionContext, request: RunRequest, callbacks: RpcCallbacks): Promise<RunResult> {
	if (request.parentSignal?.aborted) throw new Error("Subagent cancelled before session setup.");
	const model = resolveModel(request.model, ctx);
	if (!model) throw new Error("No model is available for the subagent.");
	const thinking = resolveThinking(request.thinking, ctx);
	const proc = await spawnRpcProcess({
		cwd: request.cwd,
		args: buildChildArgs(ctx, { model, thinking, systemPrompt: buildSystemPrompt(ctx, request.cwd) }),
	});
	let sessionFile: string | undefined;
	try {
		await proc.setSessionName(request.title);
	} catch {}
	try {
		sessionFile = (await proc.getState()).sessionFile;
	} catch {}
	callbacks.onSession(proc, { sessionFile, model: `${model.provider}/${model.id}`, thinking });
	const outcome = await driveRun(proc, request.prompt, { signal: request.parentSignal, callbacks });
	try {
		sessionFile = (await proc.getState()).sessionFile ?? sessionFile;
	} catch {}
	return {
		proc,
		text: outcome.text,
		error: outcome.error,
		messages: outcome.messages,
		sessionFile,
		model: outcome.model ?? `${model.provider}/${model.id}`,
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
				title: request.title,
				prompt: request.prompt,
				model: request.model,
				thinking: request.thinking,
				cwd: request.cwd,
				parentSignal: request.signal,
			},
			callbacks,
		);
	}
	let active: RpcProcess;
	if (live) {
		active = live;
	} else {
		active = await spawnRpcProcess({
			cwd: request.cwd,
			args: buildChildArgs(ctx, {
				systemPrompt: buildSystemPrompt(ctx, request.cwd),
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
		const target = resolveModel(request.model, ctx);
		if (!target) throw new Error("No model is available for the subagent.");
		await active.setModel(target.provider, target.id);
	}
	if (request.thinking) {
		try {
			await active.setThinkingLevel(request.thinking);
		} catch {}
	}
	const outcome = await driveRun(active, request.prompt, { signal: request.signal, callbacks });
	let sessionFile = request.sessionFile;
	let model = outcome.model;
	try {
		const state = await active.getState();
		sessionFile = state.sessionFile ?? sessionFile;
		if (!model && state.model) model = `${state.model.provider}/${state.model.id}`;
	} catch {}
	return {
		proc: active,
		text: outcome.text,
		error: outcome.error,
		messages: outcome.messages,
		sessionFile,
		model,
	};
}

interface DriveOptions {
	signal?: AbortSignal;
	callbacks: RpcCallbacks;
}

interface DriveOutcome {
	text: string;
	error?: string;
	aborted: boolean;
	model?: string;
	messages: RpcMessage[];
}

export async function driveRun(proc: RpcProcess, prompt: string, options: DriveOptions): Promise<DriveOutcome> {
	const { callbacks, signal } = options;
	let current = "";
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
		} else if (type === "compaction_end") {
			// The child rewrote its transcript. Re-sync once instead of polling.
			void safeMessages(proc)
				.then((messages) => callbacks.onMessages(messages))
				.catch(() => undefined);
		} else if (type === "tool_execution_start") {
			if (event.toolName === REPORT_TOOL_NAME) {
				const summary = (event.args as { summary?: unknown } | undefined)?.summary;
				if (typeof summary === "string" && summary.trim()) callbacks.onReport(summary.trim().slice(0, 4_000));
			}
		} else if (type === "tool_execution_end") {
			callbacks.onTool(typeof event.toolName === "string" ? event.toolName : "tool");
		} else if (type === "turn_end") {
			callbacks.onTurn();
		}
	});
	try {
		const attempt = await runAttempt(proc, prompt, signal);
		const model = await currentModelName(proc);
		const messages = await safeMessages(proc);
		callbacks.onMessages(messages);
		const text = lastAssistantText(messages) || current;
		if (attempt.aborted || signal?.aborted) return { text, aborted: true, model, messages };
		return { text, error: attempt.error ?? finalError(messages), aborted: false, model, messages };
	} finally {
		unsubscribe();
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

function buildSystemPrompt(ctx: ExtensionContext, cwd: string): string {
	const bridge = `<sub_agent_context>
You are a subagent launched by a parent agent. Work only on the assigned task.
Use direct tools instead of shell substitutes where practical. Be concise and report evidence.
</sub_agent_context>`;
	return `${ctx.getSystemPrompt()}\n\n${bridge}\n\n# Environment\nWorking directory: ${cwd}`;
}

interface ChildOptions {
	model?: Model<Api>;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	sessionFile?: string;
}

function buildChildArgs(ctx: ExtensionContext, options: ChildOptions): string[] {
	const args: string[] = [];
	if (options.model) args.push("--model", `${options.model.provider}/${options.model.id}`);
	if (options.thinking) args.push("--thinking", options.thinking);
	args.push("--system-prompt", options.systemPrompt);
	if (options.sessionFile) args.push("--session", options.sessionFile);
	args.push("--exclude-tools", PARENT_ONLY_TOOLS.join(","));
	args.push("--extension", REPORT_EXTENSION_PATH);
	args.push("--no-prompt-templates", "--no-themes", "--no-context-files");
	args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
	return args;
}
