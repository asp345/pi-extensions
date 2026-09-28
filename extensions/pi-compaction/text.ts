import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import {
	buildSessionContext,
	compact,
	convertToLlm,
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
import { findNativeCheckpoint, isOpenAICodexModel } from "./checkpoint.ts";
import type { CompactionConfig } from "./config.ts";
import { getOpencodeSessionHeaders } from "./headers.ts";
import { errorMessage } from "./protocol.ts";
import { sessionReasoning } from "./provider-request.ts";

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

export default function registerTextCompaction(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
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
				...providerHeadersToRecord(auth.headers),
			};
			const customInstructions = event.customInstructions
				? `${event.customInstructions}\n\n${COMMAND_INSTRUCTIONS}`
				: COMMAND_INSTRUCTIONS;
			if (model.api === "openai-completions") {
				const preparation = event.preparation;
				const branch = event.branchEntries as SessionEntry[];
				const boundary = findBoundaryQuote(branch, preparation.firstKeptEntryId);
				if (boundary) {
					const { readFiles, modifiedFiles } = computeNativeFileLists(preparation.fileOps);
					const instructions =
						buildNativeInstructions({
							customInstructions: event.customInstructions,
							previousSummary: preparation.previousSummary,
							isSplitTurn: preparation.turnPrefixMessages.length > 0,
							readFiles,
							modifiedFiles,
						}) +
						`\n\nScope: summarize ONLY the conversation strictly BEFORE the message quoted below (exclusive). Messages from the quote onward are later context kept separately; ignore them for content.\n\n<boundary>\n${boundary}\n</boundary>`;
					const messages = [
						...convertToLlm(buildSessionContext(branch).messages),
						{ role: "user" as const, content: [{ type: "text" as const, text: instructions }], timestamp: Date.now() },
					];
					const response = await ctx.modelRegistry
						.streamSimple(
							model,
							{ messages },
							{
								signal: event.signal,
								sessionId,
								maxTokens: Math.min(
									Math.floor(0.8 * preparation.settings.reserveTokens),
									model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
								),
								reasoning: sessionReasoning(model, ctx.thinkingLevel),
								headers: getOpencodeSessionHeaders(model, sessionId),
							},
						)
						.result();
					if (response.stopReason === "error" || response.stopReason === "aborted") {
						throw new Error(response.errorMessage || `Summary request ${response.stopReason}.`);
					}
					if (response.content.some((block) => block.type === "toolCall")) {
						throw new Error("Text compaction attempted to call a tool");
					}
					const summary = response.content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("")
						.trim();
					if (!summary) throw new Error("Text compaction returned an empty summary");
					return {
						compaction: {
							summary,
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
							usage: response.usage,
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
