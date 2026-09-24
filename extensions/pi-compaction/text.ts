import {
	compact,
	type ExtensionAPI,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	buildNativeInstructions,
	COMMAND_INSTRUCTIONS,
	computeNativeFileLists,
	findAnthropicCheckpoint,
	isAnthropicMessagesModel,
} from "./anthropic.ts";
import type { CompactionConfig } from "./config.ts";
import { getOpencodeSessionHeaders, withoutDeletedHeaders } from "./headers.ts";
import { findNativeCheckpoint, isOpenAICodexModel } from "./native-compaction.ts";
import {
	clearOpenAIWireSnapshots,
	getOpenAIWireBody,
	isOpenAICompletionsModel,
	recordOpenAIWireBody,
	requestOpenAISummary,
} from "./openai-summarize.ts";
import { isJsonObject } from "./protocol.ts";

export type CompactionStream = NonNullable<Parameters<typeof compact>[7]>;

function findBoundaryQuote(branch: SessionEntry[], firstKeptEntryId: string): string | undefined {
	const entry = branch.find((candidate) => candidate?.id === firstKeptEntryId);
	if (!entry) return undefined;
	for (const message of sessionEntryToContextMessages(entry)) {
		const content = (message as { content?: unknown }).content;
		const blocks =
			typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
		for (const block of blocks) {
			if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string" && text.trim().length >= 20) return text.slice(0, 200);
			}
		}
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function registerTextCompaction(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	pi.on("session_start", () => {
		clearOpenAIWireSnapshots();
	});
	pi.on("session_shutdown", () => {
		clearOpenAIWireSnapshots();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		try {
			if (!isOpenAICompletionsModel(ctx.model) || !isJsonObject(_event.payload)) return undefined;
			recordOpenAIWireBody(ctx.sessionManager.getSessionId(), _event.payload);
		} catch {}
		return undefined;
	});
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const activeModel = ctx.model;
			const checkpoint = findNativeCheckpoint(event.branchEntries as SessionEntry[]);
			if (checkpoint.status !== "none" && isOpenAICodexModel(activeModel)) return;
			const claudeCheckpoint = findAnthropicCheckpoint(event.branchEntries as SessionEntry[]);
			if (claudeCheckpoint.status !== "none" && isAnthropicMessagesModel(activeModel)) return;

			const config = getConfig();
			if (config.nativeCodex && isOpenAICodexModel(activeModel)) return;
			if (config.nativeClaude && isAnthropicMessagesModel(activeModel)) return;

			const model = activeModel;
			if (!model) {
				throw new Error("Cannot customize compaction without an active model.");
			}

			const provider = ctx.modelRegistry.getProvider(model.provider);
			if (!provider) throw new Error(`Provider not found for text compaction: ${model.provider}`);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const sessionId = ctx.sessionManager.getSessionId();
			const headers = {
				...getOpencodeSessionHeaders(requestModel, sessionId),
				...withoutDeletedHeaders(auth.headers),
			};
			const customInstructions = event.customInstructions
				? `${event.customInstructions}\n\n${COMMAND_INSTRUCTIONS}`
				: COMMAND_INSTRUCTIONS;
			if (isOpenAICompletionsModel(requestModel) && getOpenAIWireBody(sessionId)) {
				const preparation = event.preparation;
				const { readFiles, modifiedFiles } = computeNativeFileLists(preparation.fileOps);
				const boundary = findBoundaryQuote(event.branchEntries as SessionEntry[], preparation.firstKeptEntryId);
				if (boundary) {
					const instructions =
						buildNativeInstructions({
							customInstructions: event.customInstructions,
							previousSummary: preparation.previousSummary,
							isSplitTurn: preparation.turnPrefixMessages.length > 0,
							readFiles,
							modifiedFiles,
						}) +
						`\n\nScope: summarize ONLY the conversation strictly BEFORE the message quoted below (exclusive). Messages from the quote onward are later context kept separately; ignore them for content.\n\n<boundary>\n${boundary}\n</boundary>`;
					const maxTokens = Math.min(
						Math.floor(0.8 * preparation.settings.reserveTokens),
						requestModel.maxTokens > 0 ? requestModel.maxTokens : Number.POSITIVE_INFINITY,
					);
					const apiKey = auth.apiKey;
					if (!apiKey) throw new Error("API key is unavailable.");
					const summary = await requestOpenAISummary({
						model: requestModel,
						apiKey,
						callerHeaders: withoutDeletedHeaders(auth.headers) ?? {},
						sessionId,
						instruction: instructions,
						maxTokens,
						signal: event.signal,
					});
					return {
						compaction: {
							summary: summary.text,
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
							usage: summary.usage,
							details: { readFiles, modifiedFiles },
						},
					};
				}
			}
			const streamFn: CompactionStream = (streamModel, context, options) =>
				provider.streamSimple(streamModel, context, options);
			const result = await compact(
				event.preparation,
				requestModel,
				auth.apiKey,
				Object.keys(headers).length > 0 ? headers : undefined,
				customInstructions,
				event.signal,
				ctx.thinkingLevel,
				streamFn,
				auth.env,
				undefined,
				undefined,
				sessionId,
			);

			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`Text compaction failed: ${errorMessage(error)}`, "error");
			}
			return { cancel: true };
		}
	});
}
