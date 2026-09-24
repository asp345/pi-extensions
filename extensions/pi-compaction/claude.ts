import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	ANTHROPIC_NATIVE_COMPACTION_KIND,
	ANTHROPIC_NATIVE_COMPACTION_VERSION,
	type AnthropicNativeCompactionDetails,
	canonicalSystemText,
	clearAnthropicCompactionCaches,
	convertToAnthropicMessages,
	findAnthropicCheckpoint,
	hashStrippedTools,
	isAnthropicMessagesModel,
	markCompactionUnsupported,
	modelSupportsOnDemandCompaction,
	requestOnDemandSummary,
	type WireMessage,
} from "./anthropic.ts";
import { modelKey } from "./checkpoint.ts";
import type { CompactionConfig } from "./config.ts";
import { withoutDeletedHeaders } from "./headers.ts";
import { isJsonObject, type JsonObject } from "./protocol.ts";

type AgentMessages = Parameters<typeof convertToLlm>[0];
type WireSnapshot = { system: unknown; tools: unknown };
const wireSnapshots = new Map<string, WireSnapshot>();

const staleCheckpointIds = new Set<string>();
const fallbackNotices = new Set<string>();

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notifyOnce(ctx: ExtensionContext, key: string, message: string): void {
	if (!ctx.hasUI || fallbackNotices.has(key)) return;
	fallbackNotices.add(key);
	ctx.ui.notify(message, "warning");
}

function activeCheckpoint(
	ctx: ExtensionContext,
	configured: boolean,
): { entryId: string; details: AnthropicNativeCompactionDetails } | undefined {
	if (!configured || !ctx.model || !isAnthropicMessagesModel(ctx.model)) return undefined;
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const lookup = findAnthropicCheckpoint(branch);
	if (lookup.status !== "valid") return undefined;
	if (lookup.checkpoint.details.modelKey !== modelKey(ctx.model)) return undefined;
	if (staleCheckpointIds.has(lookup.checkpoint.entryId)) return undefined;
	return { entryId: lookup.checkpoint.entryId, details: lookup.checkpoint.details };
}

function assembleRangeAgentMessages(branch: SessionEntry[], startIndex: number, cutIndex: number): AgentMessages {
	const assembled: AgentMessages = [];
	for (let index = startIndex; index < cutIndex; index++) {
		const entry = branch[index];
		if (!entry) continue;
		for (const message of sessionEntryToContextMessages(entry)) {
			if ((message as { role?: unknown }).role === "system") continue;
			assembled.push(message);
		}
	}
	return assembled;
}

function dropTrailingErrorAssistants(messages: AgentMessages): AgentMessages {
	const trimmed = [...messages];
	while (trimmed.length > 0) {
		const last = trimmed[trimmed.length - 1] as { role?: unknown; stopReason?: unknown } | undefined;
		if (last?.role !== "assistant" || last.stopReason !== "error") break;
		trimmed.pop();
	}
	return trimmed as AgentMessages;
}

function hasUnansweredToolCall(messages: Message[]): boolean {
	const called = new Set<string>();
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") called.add(block.id);
			}
		} else if (message.role === "toolResult") {
			answered.add(message.toolCallId);
		}
	}
	for (const id of called) {
		if (!answered.has(id)) return true;
	}
	return false;
}

function summaryTextOf(branch: SessionEntry[], entryId: string): string | undefined {
	const entry = branch.find((candidate) => candidate?.id === entryId);
	if (entry?.type === "compaction" && typeof entry.summary === "string") return entry.summary;
	return undefined;
}

function snapshotSessionWire(ctx: ExtensionContext, payload: unknown): void {
	if (!isJsonObject(payload)) return;
	wireSnapshots.set(ctx.sessionManager.getSessionId(), {
		system: structuredClone(payload.system),
		tools: structuredClone((payload as { tools?: unknown }).tools),
	});
}

export default function claudeCompactionExtension(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	const nativeCompactionConfigured = () => getConfig().nativeClaude === true;

	pi.on("session_start", () => {
		clearAnthropicCompactionCaches();
		wireSnapshots.clear();
		staleCheckpointIds.clear();
		fallbackNotices.clear();
	});
	pi.on("session_shutdown", () => {
		clearAnthropicCompactionCaches();
		wireSnapshots.clear();
		staleCheckpointIds.clear();
		fallbackNotices.clear();
	});

	pi.on("before_provider_request", async (event, ctx) => {
		try {
			if (nativeCompactionConfigured() && isAnthropicMessagesModel(ctx.model)) {
				snapshotSessionWire(ctx, event.payload);
			}
			const checkpoint = activeCheckpoint(ctx, nativeCompactionConfigured());
			if (!checkpoint || !isJsonObject(event.payload) || !Array.isArray(event.payload.messages)) {
				return undefined;
			}
			const messages = event.payload.messages;
			const first = messages[0];
			const expected = summaryTextOf(ctx.sessionManager.getBranch() as SessionEntry[], checkpoint.entryId);
			const matches =
				isJsonObject(first) &&
				first.role === "user" &&
				Array.isArray(first.content) &&
				first.content.length === 1 &&
				isJsonObject(first.content[0]) &&
				first.content[0].type === "text" &&
				typeof first.content[0].text === "string" &&
				expected !== undefined &&
				(first.content[0].text as string).includes(expected);
			if (!matches) {
				staleCheckpointIds.add(checkpoint.entryId);
				notifyOnce(
					ctx,
					`stale:${checkpoint.entryId}`,
					"Anthropic native checkpoint no longer matches; using text history.",
				);
				return undefined;
			}
			const systemText = canonicalSystemText((event.payload as { system?: unknown }).system);
			const toolsHash = hashStrippedTools((event.payload as { tools?: unknown }).tools);
			if (systemText !== checkpoint.details.systemText || toolsHash !== checkpoint.details.toolsHash) {
				staleCheckpointIds.add(checkpoint.entryId);
				notifyOnce(
					ctx,
					`drift:${checkpoint.entryId}`,
					"System prompt or tools changed; Anthropic native checkpoint retired.",
				);
				return undefined;
			}
			const tail = messages.slice(1);
			while (
				tail.length > 0 &&
				isJsonObject(tail[0]) &&
				tail[0].role === "system" &&
				Array.isArray(tail[0].content) &&
				tail[0].content.length === 0
			) {
				tail.shift();
			}
			if (tail.length === 0) return undefined;
			return {
				...(event.payload as JsonObject),
				messages: [{ role: "assistant", content: [{ ...checkpoint.details.block }] }, ...tail],
			};
		} catch {
			return undefined;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || !isAnthropicMessagesModel(model) || !nativeCompactionConfigured()) return undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? "Anthropic authentication is unavailable." : auth.error);
			}
			const callerHeaders = withoutDeletedHeaders(auth.headers) ?? {};
			const supported = await modelSupportsOnDemandCompaction(model, auth.apiKey, callerHeaders, event.signal);
			if (!supported) return undefined;
			const snapshot = wireSnapshots.get(ctx.sessionManager.getSessionId());
			if (!snapshot || !Array.isArray(snapshot.system)) return undefined;
			const branch = event.branchEntries as SessionEntry[];
			const cutIndex = branch.findIndex((entry) => entry?.id === event.preparation.firstKeptEntryId);
			if (cutIndex < 0) return undefined;
			const lookup = findAnthropicCheckpoint(branch);
			const sameModel = lookup.status === "valid" && lookup.checkpoint.details.modelKey === modelKey(model);
			const priorBlock = sameModel ? lookup.checkpoint.details.block : undefined;
			const startIndex = sameModel ? lookup.checkpoint.entryIndex + 1 : 0;
			if (startIndex >= cutIndex) return undefined;
			let assembled = assembleRangeAgentMessages(branch, startIndex, cutIndex);
			if (event.reason === "overflow" && event.willRetry) {
				assembled = dropTrailingErrorAssistants(assembled);
			}
			assembled.push(...event.preparation.turnPrefixMessages);
			const llmMessages = convertToLlm(assembled);
			if (hasUnansweredToolCall(llmMessages)) return undefined;
			const wire = convertToAnthropicMessages(llmMessages);
			if (!wire.ok) return undefined;
			if (!wire.messages.some((message) => message.role === "user" || message.role === "assistant")) {
				return undefined;
			}
			const summaryTools = Array.isArray(snapshot.tools) ? snapshot.tools : [];
			const result = await requestOnDemandSummary({
				model,
				apiKey: auth.apiKey,
				callerHeaders,
				oauth: auth.apiKey.includes("sk-ant-oat"),
				systemBlocks: snapshot.system,
				tools: summaryTools,
				messages: [
					...(priorBlock ? [{ role: "assistant", content: [{ ...priorBlock }] } satisfies WireMessage] : []),
					...wire.messages,
				],
				signal: event.signal,
			});
			return {
				compaction: {
					summary: result.block.content,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: result.usage,
					details: {
						kind: ANTHROPIC_NATIVE_COMPACTION_KIND,
						version: ANTHROPIC_NATIVE_COMPACTION_VERSION,
						modelKey: modelKey(model),
						block: result.block,
						systemText: canonicalSystemText(snapshot.system),
						toolsHash: hashStrippedTools(summaryTools),
					},
				},
			};
		} catch (error) {
			if (event.signal.aborted) return undefined;
			const message = errorMessage(error);
			if (error instanceof Error && "status" in error && error.status === 400) markCompactionUnsupported(model);
			notifyFailure(ctx, event.signal, `Anthropic native compaction failed, using text compaction: ${message}`);
			return undefined;
		}
	});
}

function notifyFailure(ctx: ExtensionContext, signal: AbortSignal | undefined, message: string): void {
	if (signal?.aborted || !ctx.hasUI) return;
	ctx.ui.notify(message, "warning");
}
