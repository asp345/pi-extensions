import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	defineTool,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	promptWithFallbacks,
	remainingModels,
	resolveModel,
	resolveModels,
	resolveThinking,
	turnLimitAction,
} from "./fallback.ts";
import { copyParentConversation } from "./fork.ts";
import { buildSystemPrompt, createLoader, skillCatalog } from "./resources.ts";
import type { AgentDefinition, RunRequest, ThinkingLevel } from "./types.ts";
import { message, onAbort } from "./util.ts";

interface Callbacks {
	onSession(session: AgentSession): void;
	onFallback(model: Model<Api>, reason: string): void;
	onText(text: string): void;
	onTurn(): void;
	onTool(name: string): void;
	onReport(summary: string): void;
}

const REPORT_TOOL_NAME = "report_to_parent";

function reportTool(callbacks: Callbacks) {
	return defineTool({
		name: REPORT_TOOL_NAME,
		label: "Report to Parent",
		description:
			"Send a concise requested progress summary to the parent agent while this subagent continues working. Treat reported information as already delivered and do not repeat it in the final answer.",
		promptGuidelines: [
			"After using report_to_parent, do not repeat previously reported information in the final answer. Include only new findings, final status, and unresolved issues since the latest report.",
		],
		parameters: Type.Object({
			summary: Type.String({ minLength: 1, maxLength: 4_000 }),
		}),
		async execute(_callId, params) {
			callbacks.onReport(params.summary.trim());
			return {
				content: [
					{
						type: "text" as const,
						text: "Progress summary sent to the parent agent. Do not repeat reported information in the final answer; include only subsequent findings, final status, and unresolved issues.",
					},
				],
				details: {},
			};
		},
	});
}

async function childServices(
	ctx: ExtensionContext,
	definition: AgentDefinition,
	cwd: string,
	callbacks: Callbacks,
	signal?: AbortSignal,
) {
	let systemPrompt = buildSystemPrompt(definition, ctx, cwd);
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const loader = createLoader(definition, cwd, () => systemPrompt, settingsManager);
	await loader.reload();
	if (signal?.aborted) throw new Error("Subagent cancelled during resource setup.");
	const skills = skillCatalog(loader);
	if (skills)
		systemPrompt += `\n\n# Available skills\n${skills}\n\nRead a skill's SKILL.md only when the task needs it.`;
	const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
	if (!modelRuntime) throw new Error("Subagent runtime is unavailable in this Pi version.");
	return { settingsManager, loader, modelRuntime, customTools: [reportTool(callbacks)] };
}

async function bindChildSession(
	session: AgentSession,
	definition: AgentDefinition,
	callbacks: Callbacks,
	signal?: AbortSignal,
): Promise<void> {
	await session.bindExtensions({
		onError: (error) => callbacks.onTool(`extension-error:${error.extensionPath}`),
	});
	if (signal?.aborted) {
		session.dispose();
		throw new Error("Subagent cancelled during extension setup.");
	}
	try {
		assertTools(session, definition);
	} catch (error) {
		session.dispose();
		throw error;
	}
}

export async function runNew(
	ctx: ExtensionContext,
	request: RunRequest,
	callbacks: Callbacks,
): Promise<{ session: AgentSession; text: string; error?: string }> {
	const definition = request.definition;
	const signal = request.parentSignal;
	if (signal?.aborted) throw new Error("Subagent cancelled before session setup.");
	const cwd = request.worktree?.cwd ?? request.cwd;
	const services = await childServices(ctx, definition, cwd, callbacks, signal);
	const modelNames = request.model ? [request.model, ...definition.models] : definition.models;
	const models = () => resolveModels(modelNames.length ? modelNames : ["parent"], ctx, definition);
	let model = models()[0];
	if (!model) throw new Error(`Agent configuration error in ${definition.path}: no configured model is available.`);
	const preferredName = modelNames[0] ?? "parent";
	try {
		resolveModel(preferredName, ctx, definition);
	} catch {
		callbacks.onFallback(model, `Higher-priority model ${preferredName} is unavailable.`);
	}
	const sessionDir = resolveSessionDir(definition.sessionDir, cwd);
	const sessionManager = definition.persistSession
		? SessionManager.create(cwd, sessionDir ?? services.settingsManager.getSessionDir?.())
		: SessionManager.inMemory(cwd);
	const options: NonNullable<Parameters<typeof createAgentSession>[0]> & {
		modelRegistry: ExtensionContext["modelRegistry"];
	} = {
		cwd,
		agentDir: getAgentDir(),
		resourceLoader: services.loader,
		settingsManager: services.settingsManager,
		sessionManager,
		modelRegistry: ctx.modelRegistry,
		modelRuntime: services.modelRuntime as NonNullable<Parameters<typeof createAgentSession>[0]>["modelRuntime"],
		customTools: services.customTools,
		model,
	};
	const thinking = resolveThinking(definition.thinking, ctx);
	if (thinking) options.thinkingLevel = thinking;
	let session: AgentSession;
	while (true) {
		try {
			session = (await createAgentSession(options)).session;
			break;
		} catch (error) {
			const fallback = remainingModels(model, models)[0];
			if (!fallback) throw error;
			options.model = fallback;
			model = fallback;
			callbacks.onFallback(fallback, message(error));
		}
	}
	if (signal?.aborted) {
		session.dispose();
		throw new Error("Subagent cancelled during session setup.");
	}
	await bindChildSession(session, definition, callbacks, signal);

	session.setSessionName(`${definition.name}#${request.id.slice(0, 8)}`);
	if (request.fork) copyParentConversation(ctx, session);
	callbacks.onSession(session);
	const stopEvents = observe(session, request.maxTurns ?? definition.maxTurns, callbacks, signal);
	const stopAbort = onAbort(signal, () => void session.abort());
	const start = session.messages.length;
	let result: { text: string; error?: string };
	try {
		result = await promptWithFallbacks(session, request.prompt, start, {
			signal,
			models,
			callbacks,
		});
	} finally {
		stopEvents();
		stopAbort();
	}
	return { session, ...result };
}

export async function openPersistedSession(
	ctx: ExtensionContext,
	definition: AgentDefinition,
	sessionFile: string,
	cwd: string,
	callbacks: Callbacks,
	signal?: AbortSignal,
): Promise<AgentSession> {
	if (signal?.aborted) throw new Error("Subagent cancelled before session restore.");
	const services = await childServices(ctx, definition, cwd, callbacks, signal);
	const options: NonNullable<Parameters<typeof createAgentSession>[0]> & {
		modelRegistry: ExtensionContext["modelRegistry"];
	} = {
		cwd,
		agentDir: getAgentDir(),
		resourceLoader: services.loader,
		settingsManager: services.settingsManager,
		sessionManager: SessionManager.open(sessionFile),
		modelRegistry: ctx.modelRegistry,
		modelRuntime: services.modelRuntime as NonNullable<Parameters<typeof createAgentSession>[0]>["modelRuntime"],
		customTools: services.customTools,
	};
	const restored = await createAgentSession(options);
	await bindChildSession(restored.session, definition, callbacks, signal);
	if (restored.modelFallbackMessage && restored.session.model) {
		callbacks.onFallback(restored.session.model, restored.modelFallbackMessage);
	}
	callbacks.onSession(restored.session);
	return restored.session;
}

export async function resumeSession(
	session: AgentSession,
	prompt: string,
	options: {
		model?: Model<Api>;
		models?: () => Model<Api>[];
		thinking?: ThinkingLevel;
		maxTurns?: number;
		signal?: AbortSignal;
		callbacks: Callbacks;
	},
): Promise<{ text: string; error?: string }> {
	if (options.signal?.aborted) return { text: "", error: undefined };
	if (options.model) {
		try {
			await session.setModel(options.model);
		} catch (error) {
			let switched = false;
			for (const fallback of remainingModels(options.model, options.models)) {
				try {
					await session.setModel(fallback);
					options.callbacks.onFallback(fallback, message(error));
					switched = true;
					break;
				} catch {}
			}
			if (!switched) throw error;
		}
	}
	if (options.thinking) session.setThinkingLevel(options.thinking);
	const start = session.messages.length;
	const stopEvents = observe(session, options.maxTurns, options.callbacks, options.signal);
	const stopAbort = onAbort(options.signal, () => void session.abort());
	try {
		return await promptWithFallbacks(session, prompt, start, {
			signal: options.signal,
			models: options.models,
			callbacks: options.callbacks,
		});
	} finally {
		stopEvents();
		stopAbort();
	}
}

export { promptWithFallbacks, resolveModel, resolveModels, resolveThinking, turnLimitAction } from "./fallback.ts";

function observe(
	session: AgentSession,
	maxTurns: number | undefined,
	callbacks: Callbacks,
	signal?: AbortSignal,
): () => void {
	let turns = 0;
	let current = "";
	let wrapping = false;
	return session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start" && event.message.role === "assistant") current = "";
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			current += event.assistantMessageEvent.delta;
			callbacks.onText(current);
		}
		if (event.type === "tool_execution_end") callbacks.onTool(event.toolName);
		if (event.type === "turn_end") {
			turns += 1;
			callbacks.onTurn();
			const limitAction = turnLimitAction(turns, maxTurns, wrapping, signal?.aborted === true);
			if (limitAction === "warn") {
				wrapping = true;
				void session.steer(
					"You reached the configured turn limit. Give your final answer now without more tool calls.",
				);
			} else if (limitAction === "abort") void session.abort();
		}
	});
}

function assertTools(session: AgentSession, definition: AgentDefinition): void {
	const available = new Set(session.getAllTools().map((tool) => tool.name));
	const missing = definition.tools.filter((name) => !available.has(name));
	if (missing.length) {
		throw new Error(
			`Agent configuration error in ${definition.path}: missing tools: ${missing.join(", ")}. ` +
				"Every declared tool must exist in the child session's complete tool registry.",
		);
	}
	session.setActiveToolsByName([...definition.tools, REPORT_TOOL_NAME]);
}

function resolveSessionDir(value: string | undefined, cwd: string): string | undefined {
	if (!value) return undefined;
	if (value === "~" || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}
