import type { Message } from "@earendil-works/pi-ai";
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionProjection, convertToLlm } from "@earendil-works/pi-coding-agent";
import {
	ANTHROPIC_NATIVE_COMPACTION_KIND,
	ANTHROPIC_NATIVE_COMPACTION_VERSION,
	type AnthropicNativeCompactionDetails,
	buildNativeInstructions,
	COMPACT_ON_DEMAND_BETA,
	canonicalSystemText,
	computeNativeFileLists,
	findAnthropicCheckpoint,
	hashStrippedTools,
	isAnthropicMessagesModel,
	modelSupportsOnDemandCompaction,
	readCompactionResponse,
	SUMMARY_MAX_TOKENS,
} from "./anthropic.ts";
import { modelKey } from "./checkpoint.ts";
import type { CompactionConfig } from "./config.ts";
import { errorMessage, isJsonObject, type JsonObject } from "./protocol.ts";
import { requestThroughProvider, sessionReasoning } from "./provider-request.ts";

function summaryTextOf(branch: SessionEntry[], entryId: string): string | undefined {
	const entry = branch.find((candidate) => candidate?.id === entryId);
	if (entry?.type === "compaction" && typeof entry.summary === "string") return entry.summary;
	return undefined;
}

function convertStaleThinkingToText(tail: unknown[]): unknown[] {
	return tail.map((message) => {
		if (!isJsonObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}
		const content: unknown[] = [];
		for (const block of message.content) {
			if (!isJsonObject(block)) {
				content.push(block);
				continue;
			}
			if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
				content.push({ type: "text", text: block.thinking });
			} else if (block.type !== "redacted_thinking") {
				content.push(block);
			}
		}
		return { ...message, content };
	});
}

function messagesBeforeCut(branch: SessionEntry[], firstKeptEntryId: string): Message[] | undefined {
	const projection = buildSessionProjection(branch);
	const cut = projection.entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (cut <= 0) return undefined;
	return convertToLlm(projection.entries.slice(0, cut).flatMap((entry) => entry.messages));
}

export default function claudeCompactionExtension(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	const nativeCompactionConfigured = () => getConfig().nativeClaude === true;
	const staleCheckpointIds = new Set<string>();
	const fallbackNotices = new Set<string>();

	const notifyOnce = (ctx: ExtensionContext, key: string, message: string): void => {
		if (!ctx.hasUI || fallbackNotices.has(key)) return;
		fallbackNotices.add(key);
		ctx.ui.notify(message, "warning");
	};

	const activeCheckpoint = (
		ctx: ExtensionContext,
	): { entryId: string; details: AnthropicNativeCompactionDetails } | undefined => {
		if (!nativeCompactionConfigured() || !ctx.model || !isAnthropicMessagesModel(ctx.model)) return undefined;
		const lookup = findAnthropicCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (lookup.status !== "valid") return undefined;
		if (lookup.checkpoint.details.modelKey !== modelKey(ctx.model)) return undefined;
		if (staleCheckpointIds.has(lookup.checkpoint.entryId)) return undefined;
		return { entryId: lookup.checkpoint.entryId, details: lookup.checkpoint.details };
	};

	const applyCheckpoint = (ctx: ExtensionContext, payload: JsonObject): JsonObject | undefined => {
		const checkpoint = activeCheckpoint(ctx);
		if (!checkpoint || !Array.isArray(payload.messages)) return undefined;
		const messages = payload.messages;
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
			first.content[0].text.includes(expected);
		if (!matches) {
			staleCheckpointIds.add(checkpoint.entryId);
			notifyOnce(
				ctx,
				`stale:${checkpoint.entryId}`,
				"Anthropic native checkpoint no longer matches; using text history.",
			);
			return undefined;
		}
		if (
			canonicalSystemText(payload.system) !== checkpoint.details.systemText ||
			hashStrippedTools(payload.tools) !== checkpoint.details.toolsHash
		) {
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
			...payload,
			messages: [
				{ role: "assistant", content: [{ ...checkpoint.details.block }] },
				...convertStaleThinkingToText(tail),
			],
		};
	};

	pi.on("session_start", () => {
		staleCheckpointIds.clear();
		fallbackNotices.clear();
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isJsonObject(event.payload)) return undefined;
		return applyCheckpoint(ctx, event.payload);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || !isAnthropicMessagesModel(model) || !nativeCompactionConfigured()) return undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? "Anthropic authentication is unavailable." : auth.error);
			}
			const callerHeaders = providerHeadersToRecord(auth.headers) ?? {};
			if (!(await modelSupportsOnDemandCompaction(model, auth.apiKey, callerHeaders, event.signal))) return undefined;
			const branch = event.branchEntries as SessionEntry[];
			const messages = messagesBeforeCut(branch, event.preparation.firstKeptEntryId);
			if (!messages) return undefined;
			const checkpoint = activeCheckpoint(ctx);
			const { readFiles, modifiedFiles } = computeNativeFileLists(event.preparation.fileOps);
			const instructions = buildNativeInstructions({
				customInstructions: event.customInstructions,
				previousSummary: checkpoint ? undefined : event.preparation.previousSummary,
				isSplitTurn: event.preparation.turnPrefixMessages.length > 0,
				readFiles,
				modifiedFiles,
			});
			let systemText = "";
			let toolsHash = "";
			const result = await requestThroughProvider({
				ctx,
				model,
				context: { messages },
				signal: event.signal,
				maxTokens: SUMMARY_MAX_TOKENS,
				reasoning: sessionReasoning(model, ctx.thinkingLevel),
				headers: { "anthropic-beta": COMPACT_ON_DEMAND_BETA },
				editPayload: (payload) => {
					const base = applyCheckpoint(ctx, payload) ?? payload;
					systemText = canonicalSystemText(base.system);
					toolsHash = hashStrippedTools(base.tools);
					return { ...base, compaction: { type: "summarize", instructions } };
				},
				readResponse: readCompactionResponse(model),
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
						systemText,
						toolsHash,
						readFiles,
						modifiedFiles,
					},
				},
			};
		} catch (error) {
			if (event.signal.aborted) return undefined;
			if (ctx.hasUI) {
				ctx.ui.notify(`Anthropic native compaction failed, using text compaction: ${errorMessage(error)}`, "warning");
			}
			return undefined;
		}
	});
}
