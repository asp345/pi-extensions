import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./checkpoint.ts";
import { isJsonObject } from "./protocol.ts";

export const ANTHROPIC_NATIVE_COMPACTION_KIND = "anthropic-native-compaction";
export const ANTHROPIC_NATIVE_COMPACTION_VERSION = 1;
export const COMPACT_ON_DEMAND_BETA = "compact-2026-09-04";

export const SUMMARY_MAX_TOKENS = 8192;
const MODELS_API_TIMEOUT_MS = 15000;

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

export type SummaryResult = {
	block: AnthropicCompactionBlock;
	usage?: Usage;
};

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

function sseEvents(text: string): unknown[] {
	const events: unknown[] = [];
	for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (data) events.push(JSON.parse(data));
	}
	return events;
}

export function readCompactionResponse(model: Model<Api>): (response: Response) => Promise<SummaryResult> {
	return async (response) => {
		let block: AnthropicCompactionBlock | undefined;
		let stopReason = "unknown";
		let usage: unknown;
		for (const event of sseEvents(await response.text())) {
			if (!isJsonObject(event)) continue;
			if (event.type === "error") {
				const error = isJsonObject(event.error) ? event.error.message : undefined;
				throw new Error(`Anthropic compaction failed: ${typeof error === "string" ? error : "stream error"}`);
			}
			const content = event.content_block;
			if (event.type === "content_block_start" && isJsonObject(content) && content.type === "compaction") {
				if (typeof content.content !== "string" || typeof content.signature !== "string") {
					throw new Error("Anthropic compaction returned a block without content or signature.");
				}
				block = { type: "compaction", content: content.content, signature: content.signature };
			}
			if (event.type === "message_delta") {
				if (isJsonObject(event.delta) && typeof event.delta.stop_reason === "string")
					stopReason = event.delta.stop_reason;
				usage = event.usage;
			}
		}
		if (!block || stopReason !== "compaction") {
			throw new Error(`Anthropic compaction returned stop_reason ${stopReason}.`);
		}
		return { block, usage: usageFromIterations(model, { usage }) };
	};
}
