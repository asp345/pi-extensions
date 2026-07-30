import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { definitionBody } from "./definitions.js";
import type { AgentDefinition, RunRequest, ThinkingLevel } from "./types.js";
import { compact, message, onAbort } from "./util.js";

interface Callbacks {
	onSession(session: AgentSession): void;
	onFallback(model: Model<Api>, reason: string): void;
	onText(text: string): void;
	onTurn(): void;
	onTool(name: string): void;
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
	let systemPrompt = buildSystemPrompt(definition, ctx, cwd);
	const loader = createLoader(definition, cwd, () => systemPrompt);
	await loader.reload();
	if (signal?.aborted) throw new Error("Subagent cancelled during resource setup.");
	const skills = skillCatalog(loader);
	if (skills)
		systemPrompt += `\n\n# Available skills\n${skills}\n\nRead a skill's SKILL.md only when the task needs it.`;

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
	const settingsManager = SettingsManager.create(cwd, getAgentDir());
	const sessionDir = resolveSessionDir(definition.sessionDir, cwd);
	const sessionManager = definition.persistSession
		? SessionManager.create(cwd, sessionDir ?? settingsManager.getSessionDir?.())
		: SessionManager.inMemory(cwd);
	const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
	if (!modelRuntime) throw new Error("Subagent runtime is unavailable in this Pi version.");
	const options: NonNullable<Parameters<typeof createAgentSession>[0]> & {
		modelRegistry: ExtensionContext["modelRegistry"];
	} = {
		cwd,
		agentDir: getAgentDir(),
		resourceLoader: loader,
		settingsManager,
		sessionManager,
		modelRegistry: ctx.modelRegistry,
		modelRuntime: modelRuntime as NonNullable<Parameters<typeof createAgentSession>[0]>["modelRuntime"],
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

export function resolveThinking(input: AgentDefinition["thinking"], ctx: ExtensionContext): ThinkingLevel | undefined {
	return input === "parent" ? (ctx.thinkingLevel as ThinkingLevel | undefined) : input;
}

function createLoader(definition: AgentDefinition, cwd: string, systemPrompt: () => string): DefaultResourceLoader {
	const extensionSpec = Array.isArray(definition.extensions)
		? extensionSelection(definition.extensions, cwd)
		: undefined;
	const excluded = new Set(definition.excludeExtensions.map((name) => name.toLowerCase()));
	const loadAll = definition.extensions === true;
	const noExtensions = definition.extensions === false;
	type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
	const extensionsOverride: LoaderOptions["extensionsOverride"] =
		noExtensions || (loadAll && !excluded.size)
			? undefined
			: (current) => ({
					...current,
					extensions: current.extensions.filter((extension: { path: string }) => {
						const name = extensionName(extension.path);
						return !excluded.has(name) && (loadAll || extensionSpec?.names.has(name));
					}),
				});
	const selectedSkills = Array.isArray(definition.skills)
		? new Set(definition.skills.map((name) => name.toLowerCase()))
		: undefined;
	const skillsOverride: LoaderOptions["skillsOverride"] = selectedSkills
		? (current) => ({
				...current,
				skills: current.skills.filter((skill: { name: string }) => selectedSkills.has(skill.name.toLowerCase())),
			})
		: undefined;
	return new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions,
		additionalExtensionPaths: extensionSpec?.paths,
		extensionsOverride,
		noSkills: definition.skills === false,
		skillsOverride,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: systemPrompt,
		appendSystemPromptOverride: () => [],
	});
}

function skillCatalog(loader: DefaultResourceLoader): string {
	return loader
		.getSkills()
		.skills.map((skill) => {
			const description = compact(String(skill.description ?? ""), 240);
			return `- ${skill.name}: ${description || "No description"} (${skill.filePath})`;
		})
		.join("\n");
}

function buildSystemPrompt(definition: AgentDefinition, ctx: ExtensionContext, cwd: string): string {
	const body = definitionBody(definition);
	const bridge = `<sub_agent_context>
You are the selected ${definition.name} subagent. Work only on the assigned task.
Use direct tools instead of shell substitutes where practical. Be concise and report evidence.
</sub_agent_context>`;
	const environment = `<active_agent name="${escapeXml(definition.name)}"/>

# Environment
Working directory: ${cwd}`;
	const memory = definition.memory
		? `\n\n# Memory\nMemory scope: ${definition.memory}. Use ${memoryPath(definition, cwd)} when the task requires persistent memory; do not read it speculatively.`
		: "";
	if (definition.promptMode === "append") {
		return `${ctx.getSystemPrompt()}\n\n${bridge}\n\n${environment}\n\n<agent_instructions>\n${body}\n</agent_instructions>${memory}`;
	}
	return `${bridge}\n\n${environment}\n\n${body}${memory}`;
}

function memoryPath(definition: AgentDefinition, cwd: string): string {
	if (definition.memory === "user") return join(getAgentDir(), "agent-memory", definition.name, "MEMORY.md");
	if (definition.memory === "local") return join(cwd, ".agents", "memory", definition.name, "MEMORY.md");
	return join(cwd, ".pi", "agent-memory", definition.name, "MEMORY.md");
}

type SessionMessage = AgentSession["messages"][number];
type ContentMessage = Extract<SessionMessage, { content: unknown }>;

function isSessionMessage(value: unknown): value is ContentMessage {
	return isRecord(value) && typeof value.role === "string" && "content" in value;
}

function copyParentConversation(ctx: ExtensionContext, session: AgentSession): void {
	const manager = ctx.sessionManager as unknown as {
		buildContextEntries?: () => unknown[];
		getBranch: () => unknown[];
	};
	const entries = manager.buildContextEntries?.() ?? manager.getBranch();
	const messages = entries
		.flatMap<ContentMessage>((entry) => {
			if (!isRecord(entry)) return [];
			if (entry.type === "message" && isSessionMessage(entry.message)) return [entry.message];
			if (isSessionMessage(entry)) return [entry];
			if (entry.type === "compaction" && typeof entry.summary === "string") {
				return [
					{
						role: "user",
						content: [{ type: "text", text: `[Parent summary]\n${entry.summary}` }],
						timestamp: Date.now(),
					},
				];
			}
			return [];
		})
		.map(compactForkMessage);
	const summary = messages.find((message) => contentText(message.content).startsWith("[Parent summary]"));
	const tail: ContentMessage[] = [];
	let chars = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message === summary) continue;
		const size = JSON.stringify(message).length;
		if (tail.length && chars + size > 160_000) break;
		tail.unshift(message);
		chars += size;
	}
	const selected = summary ? [summary, ...tail] : tail;
	const resultIds = new Set(
		selected.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	const callIds = new Set<string>();
	for (const message of selected) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		message.content = message.content.filter((part) => part.type !== "toolCall" || resultIds.has(part.id));
		for (const part of message.content) if (part.type === "toolCall") callIds.add(part.id);
	}
	const consistent = selected.filter((message) => {
		if (message.role === "toolResult") return callIds.has(message.toolCallId);
		if (message.role === "assistant" && Array.isArray(message.content)) return message.content.length > 0;
		return true;
	});
	if (consistent.length) session.agent.state.messages = structuredClone(consistent);
}

function compactForkMessage(message: ContentMessage): ContentMessage {
	const copy = structuredClone(message);
	if (copy.role !== "toolResult" || !Array.isArray(copy.content)) return copy;
	copy.content = copy.content.map((part) =>
		part.type === "text" && typeof part.text === "string"
			? {
					...part,
					text: part.text.length > 4_000 ? `${part.text.slice(0, 4_000)}\n[Tool result truncated for fork]` : part.text,
				}
			: part.type === "image"
				? { type: "text", text: "[Image omitted from fork]" }
				: part,
	);
	return copy;
}

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

export function turnLimitAction(
	turns: number,
	maxTurns: number | undefined,
	wrapping: boolean,
	cancelled: boolean,
): "warn" | "abort" | undefined {
	if (cancelled || !maxTurns || turns < maxTurns) return undefined;
	if (!wrapping) return "warn";
	return turns > maxTurns ? "abort" : undefined;
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
	session.setActiveToolsByName(definition.tools);
}

interface FallbackPromptOptions {
	signal?: AbortSignal;
	models?: () => Model<Api>[];
	callbacks: Callbacks;
}

export async function promptWithFallbacks(
	session: AgentSession,
	prompt: string,
	start: number,
	options: FallbackPromptOptions,
): Promise<{ text: string; error?: string }> {
	const attempt = async (text: string, errorStart: number): Promise<{ aborted: boolean; error?: string }> => {
		let error: string | undefined;
		try {
			if (!options.signal?.aborted) await session.prompt(text);
		} catch (caught) {
			error = message(caught);
		}
		if (options.signal?.aborted) return { aborted: true };
		return { aborted: false, error: error ?? finalError(session, errorStart) };
	};
	const first = await attempt(prompt, start);
	if (first.aborted || !first.error) return { text: lastAssistantText(session, start) };

	let currentError = first.error;
	const failures = [`Primary model failed: ${currentError}`];
	for (const fallback of remainingModels(session.model, options.models)) {
		try {
			await session.setModel(fallback);
		} catch (error) {
			failures.push(`Fallback model ${modelName(fallback)} failed to initialize: ${message(error)}`);
			continue;
		}
		options.callbacks.onFallback(fallback, currentError);
		const retryStart = session.messages.length;
		const continuation = [
			"The previous model failed before completing the assigned task.",
			"Continue the original task from the existing conversation state using this fallback model.",
			"Do not repeat tool actions that already completed successfully.",
		].join(" ");
		const retry = await attempt(continuation, retryStart);
		if (retry.aborted) return { text: lastAssistantText(session, start) };
		if (!retry.error) {
			return { text: lastAssistantText(session, retryStart) || lastAssistantText(session, start) };
		}
		currentError = retry.error;
		failures.push(`Fallback model ${modelName(fallback)} failed: ${currentError}`);
	}
	return { text: lastAssistantText(session, start), error: failures.join("; ") };
}

function remainingModels(current: Model<Api> | undefined, resolve?: () => Model<Api>[]): Model<Api>[] {
	let models: Model<Api>[];
	try {
		models = resolve?.() ?? [];
	} catch {
		return [];
	}
	if (!current) return models;
	const index = models.findIndex((model) => sameModel(model, current));
	return index >= 0 ? models.slice(index + 1) : models.filter((model) => !sameModel(model, current));
}

function modelName(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function sameModel(left: Model<Api>, right: Model<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}

export function resolveModels(
	inputs: readonly string[],
	ctx: ExtensionContext,
	definition?: AgentDefinition,
): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const input of inputs) {
		try {
			const model = resolveModel(input, ctx, definition);
			if (model && !models.some((existing) => sameModel(existing, model))) models.push(model);
		} catch {}
	}
	return models;
}

export function resolveModel(
	input: string | undefined,
	ctx: ExtensionContext,
	definition?: AgentDefinition,
): Model<Api> | undefined {
	if (!input || input.trim().toLowerCase() === "parent") return ctx.model as Model<Api> | undefined;
	const registry = ctx.modelRegistry as unknown as {
		find(provider: string, id: string): Model<Api> | undefined;
		getAvailable?: () => Model<Api>[];
		getAll?: () => Model<Api>[];
	};
	const models = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	const lower = input.toLowerCase();
	let found = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
	if (!found) {
		const matches = models.filter((model) =>
			`${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(lower),
		);
		if (matches.length === 1) found = matches[0];
	}
	if (!found && input.includes("/")) {
		const slash = input.indexOf("/");
		found = registry.find(input.slice(0, slash), input.slice(slash + 1));
	}
	if (!found) {
		throw new Error(
			`Agent configuration error${definition ? ` in ${definition.path}` : ""}: model ${input} is unavailable.`,
		);
	}
	return found;
}

function extensionSelection(entries: string[], cwd: string): { names: Set<string>; paths: string[] } {
	const names = new Set<string>();
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.includes("/") || entry.includes("\\") || entry.startsWith("~")) {
			const expanded = entry === "~" || entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
			const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
			paths.push(path);
			names.add(extensionName(path));
		} else names.add(entry.toLowerCase());
	}
	return { names, paths };
}

function extensionName(path: string): string {
	const base = basename(path);
	return (
		base === "index.ts" || base === "index.js" ? basename(dirname(path)) : base.replace(/\.(?:ts|js)$/u, "")
	).toLowerCase();
}

function lastAssistantText(session: AgentSession, start: number): string {
	for (let index = session.messages.length - 1; index >= start; index -= 1) {
		const message = session.messages[index];
		if (message.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (text) return text;
	}
	return "";
}

function finalError(session: AgentSession, start: number): string | undefined {
	for (let index = session.messages.length - 1; index >= start; index -= 1) {
		const message = session.messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage?.trim() || "provider error";
		if (message.stopReason === "length" && !contentText(message.content).trim())
			return "output token limit reached before an answer";
		return undefined;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
}

export function compactTranscript(session: AgentSession): string {
	const results = new Map<string, { error: boolean; summary: string }>();
	for (const message of session.messages) {
		if (message.role !== "toolResult") continue;
		results.set(message.toolCallId, {
			error: message.isError === true,
			summary: compact(contentText(message.content), 300),
		});
	}
	const lines: string[] = [];
	for (const message of session.messages) {
		if (message.role === "user") {
			const text = contentText(message.content).trim();
			if (text) lines.push(`User:\n${text}`);
		} else if (message.role === "assistant") {
			const text = contentText(message.content).trim();
			if (text) lines.push(`Assistant:\n${text}`);
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part.type !== "toolCall") continue;
				const result = results.get(part.id);
				lines.push(
					result?.error
						? `[Tool ${part.name}: error: ${result.summary || "failed"}]`
						: `[Tool ${part.name}: ${result ? "ok" : "invoked"}]`,
				);
			}
		}
	}
	return lines.join("\n\n");
}

function resolveSessionDir(value: string | undefined, cwd: string): string | undefined {
	if (!value) return undefined;
	if (value === "~" || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}

function escapeXml(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}
