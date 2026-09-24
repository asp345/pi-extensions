import { randomUUID } from "node:crypto";
import {
	buildBillingPlaceholder,
	CLAUDE_CODE_LEGACY_IDENTITY,
	CLAUDE_CODE_USER_AGENT,
	firstUserText,
	wrapFetchForCch,
} from "@asp345/pi-anthropic-oauth";
import {
	type Api,
	calculateCost,
	type ImageContent,
	type Message,
	type Model,
	type TextContent,
	type ThinkingContent,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./checkpoint.ts";
import { isJsonObject, type JsonObject } from "./protocol.ts";

export const ANTHROPIC_NATIVE_COMPACTION_KIND = "anthropic-native-compaction";
export const ANTHROPIC_NATIVE_COMPACTION_VERSION = 1;
export const COMPACT_ON_DEMAND_BETA = "compact-2026-09-04";
export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";

const SUMMARY_MAX_TOKENS = 8192;
const MODELS_API_TIMEOUT_MS = 15000;
const SUMMARY_TIMEOUT_MS = 300000;
const MAX_SUMMARY_ATTEMPTS = 3;

export const COMMAND_INSTRUCTIONS = `In the \`## Critical Context\` section, preserve a \`Build & Run Commands\` subsection. Record the exact setup, install, build, test, run, and lint commands from successful bash tool calls verbatim. Preserve the working directory, required environment variables, prerequisites, and success criteria for each command. If a category has no applicable command, explicitly write \`none\`. If a command or any of its details has not been verified, explicitly write \`unknown\` instead of guessing. Do not invent, normalize, shorten, or replace commands with equivalent commands. Preserve existing command entries across later compactions unless a newer successful command supersedes one. Also write a \`Mistakes\` subsection to record previous mistakes.`;

const SUMMARY_FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const SUMMARIZATION_BASE = `Summarize the conversation in this request. Create a structured context checkpoint summary that another LLM will use to continue the work.

${SUMMARY_FORMAT}`;

const UPDATE_SUMMARIZATION_BASE = `Update the existing structured summary with new information from the conversation in this request. The existing summary is provided in <previous-summary> tags and is also carried in the leading compaction block of the messages. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

${SUMMARY_FORMAT}`;

export interface NativeInstructionsInput {
	customInstructions?: string;
	previousSummary?: string;
	isSplitTurn: boolean;
	readFiles: string[];
	modifiedFiles: string[];
}

export function computeNativeFileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

export function buildNativeInstructions(input: NativeInstructionsInput): string {
	const custom = input.customInstructions
		? `${input.customInstructions}\n\n${COMMAND_INSTRUCTIONS}`
		: COMMAND_INSTRUCTIONS;
	const base = input.previousSummary ? UPDATE_SUMMARIZATION_BASE : SUMMARIZATION_BASE;
	let instructions = input.previousSummary
		? `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n${base}`
		: base;
	instructions += `\n\nAdditional focus: ${custom}`;
	const sections: string[] = [];
	if (input.readFiles.length > 0) sections.push(`<read-files>\n${input.readFiles.join("\n")}\n</read-files>`);
	if (input.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${input.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length > 0) {
		instructions += `\n\nEnd the summary with exactly these file sections, using verbatim paths:\n\n${sections.join("\n\n")}`;
	}
	if (input.isSplitTurn) {
		instructions += `\n\nThe trailing messages of this request belong to the current user turn, which is still in progress. Write the history summary first, then a horizontal rule, then a Turn Context section with Original Request, Progress So Far, and Context Needed to Continue.`;
	}
	return instructions;
}

export interface AnthropicCompactionBlock {
	type: "compaction";
	content: string;
	signature: string;
}

export interface AnthropicNativeCompactionDetails {
	kind: typeof ANTHROPIC_NATIVE_COMPACTION_KIND;
	version: typeof ANTHROPIC_NATIVE_COMPACTION_VERSION;
	modelKey: string;
	block: AnthropicCompactionBlock;
	systemText: string;
	toolsHash: string;
}

type AnthropicCheckpoint = {
	entryIndex: number;
	entryId: string;
	details: AnthropicNativeCompactionDetails;
};

type CheckpointLookup = { status: "none" } | { status: "valid"; checkpoint: AnthropicCheckpoint };

export function isAnthropicMessagesModel(model: unknown): model is Model<"anthropic-messages"> {
	if (!isJsonObject(model)) return false;
	return model.provider === "anthropic" && model.api === "anthropic-messages";
}

function parseAnthropicCompactionDetails(value: unknown): AnthropicNativeCompactionDetails | undefined {
	if (!isJsonObject(value)) return undefined;
	if (value.kind !== ANTHROPIC_NATIVE_COMPACTION_KIND || value.version !== ANTHROPIC_NATIVE_COMPACTION_VERSION)
		return undefined;
	if (typeof value.modelKey !== "string") return undefined;
	if (typeof value.systemText !== "string" || typeof value.toolsHash !== "string") return undefined;
	const block = value.block;
	if (!isJsonObject(block) || block.type !== "compaction") return undefined;
	if (typeof block.content !== "string" || typeof block.signature !== "string") return undefined;
	return {
		kind: ANTHROPIC_NATIVE_COMPACTION_KIND,
		version: ANTHROPIC_NATIVE_COMPACTION_VERSION,
		modelKey: value.modelKey,
		block: { type: "compaction", content: block.content, signature: block.signature },
		systemText: value.systemText,
		toolsHash: value.toolsHash,
	};
}

export function findAnthropicCheckpoint(branch: SessionEntry[]): CheckpointLookup {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.type === "compaction") {
			if (!isJsonObject(entry.details) || entry.details.kind !== ANTHROPIC_NATIVE_COMPACTION_KIND) {
				return { status: "none" };
			}
			const details = parseAnthropicCompactionDetails(entry.details);
			if (!details) return { status: "none" };
			return { status: "valid", checkpoint: { entryIndex: index, entryId: entry.id, details } };
		}
		if (entry.type === "custom" && entry.customType === ANTHROPIC_NATIVE_COMPACTION_KIND) {
			const details = parseAnthropicCompactionDetails(entry.data);
			if (!details) return { status: "none" };
			return { status: "valid", checkpoint: { entryIndex: index, entryId: entry.id, details } };
		}
	}
	return { status: "none" };
}

const compactionSupportByModel = new Map<string, boolean>();

export function clearAnthropicCompactionCaches(): void {
	compactionSupportByModel.clear();
}

const FALLBACK_COMPACTION_MODEL_PATTERN = /^claude-(fable|mythos|opus|sonnet)/i;

function resolveAnthropicUrl(baseUrl: string | undefined, path: string): string {
	const base = (baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
	return `${base}${path}`;
}

async function fetchJson(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		const response = await fetch(url, { ...init, signal: combined });
		let json: unknown;
		try {
			json = await response.json();
		} catch {}
		return { status: response.status, json };
	} finally {
		clearTimeout(timeout);
	}
}

export async function modelSupportsOnDemandCompaction(
	model: Model<Api>,
	apiKey: string,
	callerHeaders: Record<string, string>,
	signal?: AbortSignal,
): Promise<boolean> {
	const key = modelKey(model);
	const cached = compactionSupportByModel.get(key);
	if (cached !== undefined) return cached;
	let supported = FALLBACK_COMPACTION_MODEL_PATTERN.test(model.id);
	try {
		const { status, json } = await fetchJson(
			resolveAnthropicUrl(model.baseUrl, `/v1/models/${encodeURIComponent(model.id)}`),
			{
				headers: {
					accept: "application/json",
					"anthropic-version": "2023-06-01",
					"anthropic-beta": COMPACT_ON_DEMAND_BETA,
					authorization: `Bearer ${apiKey}`,
					...callerHeaders,
				},
			},
			MODELS_API_TIMEOUT_MS,
			signal,
		);
		if (status === 200 && isJsonObject(json) && isJsonObject(json.capabilities)) {
			const compaction = json.capabilities.compaction;
			supported = compaction === true || (isJsonObject(compaction) && compaction.supported === true);
		}
	} catch {}
	compactionSupportByModel.set(key, supported);
	return supported;
}

type WireBlock = { type: string; [key: string]: unknown };
export type WireMessage = { role: "user" | "assistant" | "system"; content: string | WireBlock[] };

export type ConvertMessagesResult = { ok: true; messages: WireMessage[] } | { ok: false; reason: string };

function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const ANTHROPIC_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function convertImageBlock(block: ImageContent): WireBlock | undefined {
	if (!ANTHROPIC_IMAGE_MIME_TYPES.has(block.mimeType)) return undefined;
	return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
}

function convertUserContent(content: UserMessage["content"]): string | WireBlock[] | null | undefined {
	if (typeof content === "string") return content.trim().length > 0 ? content : null;
	const blocks: WireBlock[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.trim().length === 0) continue;
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const converted = convertImageBlock(block);
			if (!converted) return undefined;
			blocks.push(converted);
		} else {
			return undefined;
		}
	}
	return blocks.length > 0 ? blocks : null;
}

function convertThinkingBlock(block: ThinkingContent): WireBlock | null | undefined {
	if (block.redacted) {
		if (typeof block.thinkingSignature !== "string") return undefined;
		return { type: "redacted_thinking", data: block.thinkingSignature };
	}
	const signature = block.thinkingSignature;
	const hasSignature = typeof signature === "string" && signature.trim().length > 0;
	if (block.thinking.trim().length === 0 && !hasSignature) return null;
	if (!hasSignature) return { type: "text", text: block.thinking };
	return { type: "thinking", thinking: block.thinking, signature };
}

function convertToolResultBlocks(message: { content: (TextContent | ImageContent)[] }): WireBlock[] | undefined {
	const blocks: WireBlock[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const converted = convertImageBlock(block);
			if (!converted) return undefined;
			blocks.push(converted);
		} else {
			return undefined;
		}
	}
	return blocks;
}

export function convertToAnthropicMessages(messages: Message[]): ConvertMessagesResult {
	const out: WireMessage[] = [];
	let pendingToolResults: WireBlock[] = [];
	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			out.push({ role: "user", content: pendingToolResults });
			pendingToolResults = [];
		}
	};
	for (const message of messages) {
		if (message.role === "toolResult") {
			const blocks = convertToolResultBlocks(message);
			if (!blocks) return { ok: false, reason: "unsupported tool result content" };
			pendingToolResults.push({
				type: "tool_result",
				tool_use_id: normalizeToolCallId(message.toolCallId),
				content: blocks,
				is_error: message.isError === true,
			});
			continue;
		}
		flushToolResults();
		if (message.role === "user") {
			const content = convertUserContent(message.content);
			if (content === undefined) return { ok: false, reason: "unsupported user content" };
			if (content === null) continue;
			out.push({ role: "user", content });
		} else if (message.role === "assistant") {
			const blocks: WireBlock[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const converted = convertThinkingBlock(block);
					if (converted === undefined) return { ok: false, reason: "unsupported thinking block" };
					if (converted !== null) blocks.push(converted);
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: normalizeToolCallId(block.id),
						name: block.name,
						input: block.arguments ?? {},
					});
				} else {
					return { ok: false, reason: "unsupported assistant content" };
				}
			}
			if (blocks.length === 0) continue;
			out.push({ role: "assistant", content: blocks });
		} else if (message.role === "system") {
			return { ok: false, reason: "mid-conversation system message" };
		} else {
			return { ok: false, reason: "unsupported message role" };
		}
	}
	flushToolResults();
	return { ok: true, messages: out };
}

export type WireTool = { name: string; description: string; input_schema: Record<string, unknown> };

export function canonicalSystemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return "";
	const parts: string[] = [];
	for (const block of system) {
		if (isJsonObject(block) && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function stripToolDecorations(tool: unknown): unknown {
	if (!isJsonObject(tool)) return tool;
	const copy = { ...tool };
	for (const key of ["eager_input_streaming", "strict", "cache_control", "defer_loading"]) delete copy[key];
	return copy;
}

export function hashStrippedTools(tools: unknown): string {
	const list = Array.isArray(tools) ? tools.map(stripToolDecorations) : [];
	list.sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
	return canonicalJson(list);
}

function stripCacheControl(blocks: unknown[]): void {
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (isJsonObject(block) && block.cache_control !== undefined) {
			const copy = { ...block };
			delete copy.cache_control;
			blocks[index] = copy;
		}
	}
}

function markEphemeral(blocks: unknown[], skipDeferredTools = false): void {
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (!isJsonObject(block)) continue;
		if (skipDeferredTools && block.defer_loading === true) continue;
		blocks[index] = { ...block, cache_control: { type: "ephemeral" } };
		return;
	}
}

class SummaryRequestError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
		readonly status?: number,
	) {
		super(message);
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status === 529 || status >= 500;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Compaction aborted"));
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export type SummaryRequest = {
	model: Model<Api>;
	apiKey: string;
	callerHeaders: Record<string, string>;
	oauth: boolean;
	systemBlocks: unknown[];
	tools: unknown[];
	messages: WireMessage[];
	instructions: string;
	signal?: AbortSignal;
};

export type SummaryResult = {
	block: AnthropicCompactionBlock;
	usage?: Usage;
};

function blockFromResponse(json: unknown): AnthropicCompactionBlock | undefined {
	if (!isJsonObject(json) || json.stop_reason !== "compaction") return undefined;
	if (!Array.isArray(json.content) || json.content.length !== 1) return undefined;
	const block = json.content[0];
	if (!isJsonObject(block) || block.type !== "compaction") return undefined;
	if (typeof block.content !== "string" || typeof block.signature !== "string") return undefined;
	return { type: "compaction", content: block.content, signature: block.signature };
}

function usageFromIterations(model: Model<Api>, json: unknown): Usage | undefined {
	if (!isJsonObject(json) || !isJsonObject(json.usage)) return undefined;
	const iterations = json.usage.iterations;
	if (!Array.isArray(iterations)) return undefined;
	const entry = iterations.find((item) => isJsonObject(item) && item.type === "compaction");
	if (!isJsonObject(entry)) return undefined;
	const input = typeof entry.input_tokens === "number" ? entry.input_tokens : 0;
	const output = typeof entry.output_tokens === "number" ? entry.output_tokens : 0;
	const cacheRead = typeof entry.cache_read_input_tokens === "number" ? entry.cache_read_input_tokens : 0;
	const cacheWrite = typeof entry.cache_creation_input_tokens === "number" ? entry.cache_creation_input_tokens : 0;
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const CC_TOOL_NAMES = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];
const CC_TOOL_LOOKUP = new Map(CC_TOOL_NAMES.map((name) => [name.toLowerCase(), name]));

const DEFERRED_TOOL_PLACEHOLDER = {
	name: "__pi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};

function toClaudeCodeToolName(name: unknown): unknown {
	if (typeof name !== "string") return name;
	return CC_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;
}

function toWireToolsForOAuth(tools: unknown[]): unknown[] {
	const mapped = tools.map((tool) => {
		if (!isJsonObject(tool)) return tool;
		return { ...tool, name: toClaudeCodeToolName(tool.name) };
	});
	if (mapped.length > 0 && !mapped.some((tool) => isJsonObject(tool) && tool.name === DEFERRED_TOOL_PLACEHOLDER.name)) {
		mapped.push({ ...DEFERRED_TOOL_PLACEHOLDER });
	}
	return mapped;
}

export async function requestOnDemandSummary(params: SummaryRequest): Promise<SummaryResult> {
	const promptId = randomUUID();
	const billing = params.oauth ? buildBillingPlaceholder(promptId, firstUserText(params.messages)) : undefined;
	const system = [...(billing ? [{ type: "text", text: billing }] : []), ...params.systemBlocks];
	if (params.oauth && billing) {
		const identityIndex = system.findIndex(
			(block) => isJsonObject(block) && block.type === "text" && block.text === CLAUDE_CODE_IDENTITY,
		);
		const legacy = system[1];
		if (
			identityIndex < 0 &&
			isJsonObject(legacy) &&
			legacy.type === "text" &&
			legacy.text === CLAUDE_CODE_LEGACY_IDENTITY
		) {
			system[1] = { type: "text", text: CLAUDE_CODE_IDENTITY };
		} else if (identityIndex < 0) {
			system.splice(1, 0, { type: "text", text: CLAUDE_CODE_IDENTITY });
		}
	}
	const tools = params.oauth ? toWireToolsForOAuth([...params.tools]) : [...params.tools];
	const messages = params.messages.map((message) =>
		Array.isArray(message.content)
			? { ...message, content: message.content.map((block) => ({ ...block })) }
			: { ...message },
	);
	stripCacheControl(system);
	stripCacheControl(tools);
	markEphemeral(system);
	markEphemeral(tools, true);
	const lastMessage = messages.at(-1);
	if (lastMessage && Array.isArray(lastMessage.content)) markEphemeral(lastMessage.content);
	const body: JsonObject = {
		model: params.model.id,
		max_tokens: SUMMARY_MAX_TOKENS,
		stream: false,
		system,
		...(tools.length > 0 ? { tools } : {}),
		messages,
		compaction: { type: "summarize", instructions: params.instructions },
	};
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": `${ANTHROPIC_OAUTH_BETA},${COMPACT_ON_DEMAND_BETA}`,
		authorization: `Bearer ${params.apiKey}`,
		"x-client-request-id": randomUUID(),
		...params.callerHeaders,
	};
	if (params.oauth) {
		headers["user-agent"] = CLAUDE_CODE_USER_AGENT;
		headers["x-app"] = "cli";
	}
	const url = resolveAnthropicUrl(params.model.baseUrl, "/v1/messages");
	const doFetch = params.oauth ? wrapFetchForCch(fetch) : fetch;
	const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
	const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
	let lastError = "Anthropic compaction failed.";
	for (let attempt = 0; attempt < MAX_SUMMARY_ATTEMPTS; attempt++) {
		try {
			const response = await doFetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new SummaryRequestError(
					`Anthropic compaction failed (${response.status}): ${text || response.statusText}`,
					isRetryableStatus(response.status),
					response.status,
				);
			}
			const json = (await response.json()) as unknown;
			const block = blockFromResponse(json);
			if (!block) {
				const reason = isJsonObject(json) && typeof json.stop_reason === "string" ? json.stop_reason : "unknown";
				throw new SummaryRequestError(`Anthropic compaction returned stop_reason ${reason}.`, false);
			}
			return { block, usage: usageFromIterations(params.model, json) };
		} catch (error) {
			if (params.signal?.aborted) throw error;
			if (error instanceof SummaryRequestError) {
				lastError = error.message;
				if (!error.retryable || attempt === MAX_SUMMARY_ATTEMPTS - 1) throw error;
				await delay(1000 * 2 ** attempt, params.signal);
				continue;
			}
			throw error;
		}
	}
	throw new Error(lastError);
}
