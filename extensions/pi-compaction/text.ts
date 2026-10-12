import { errorMessage } from "@asp345/pi-shared/format.ts";
import { isRecord } from "@asp345/pi-shared/json.ts";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { findNativeCheckpoint, isOpenAICodexModel } from "./checkpoint.ts";
import type { CompactionConfig } from "./config.ts";
import { getOpencodeSessionHeaders } from "./headers.ts";
import { buildSummaryInstructions, computeFileLists } from "./instructions.ts";
import { sessionReasoning } from "./provider-request.ts";

const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_addition", "tool_removal"]);

function cacheOnlyPreviousRequestPrefix(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	let cacheControl: unknown;
	const messages: unknown[] = payload.messages.map((message) => {
		if (!isRecord(message) || !Array.isArray(message.content)) return message;
		const content = message.content.map((block) => {
			if (!isRecord(block) || !("cache_control" in block)) return block;
			const { cache_control, ...rest } = block;
			cacheControl = cache_control;
			return rest;
		});
		return { ...message, content };
	});
	const lastAssistant = messages.findLastIndex((message) => isRecord(message) && message.role === "assistant");
	for (let index = lastAssistant - 1; cacheControl !== undefined && index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message)) continue;
		if (typeof message.content === "string") {
			messages[index] = { ...message, content: [{ type: "text", text: message.content, cache_control: cacheControl }] };
			break;
		}
		if (!Array.isArray(message.content) || message.content.length === 0) continue;
		const last = message.content.at(-1);
		if (isRecord(last) && typeof last.type === "string" && CACHEABLE_BLOCK_TYPES.has(last.type)) {
			messages[index] = {
				...message,
				content: [...message.content.slice(0, -1), { ...last, cache_control: cacheControl }],
			};
		}
		break;
	}
	return { ...payload, messages };
}

function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	if (typeof message.command === "string") return message.command;
	if (typeof message.summary === "string") return message.summary;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "toolCall" && typeof block.name === "string") {
				return `${block.name} ${JSON.stringify(block.arguments)}`;
			}
			return "";
		})
		.filter((text) => text.trim().length > 0)
		.join("\n");
}

function findBoundaryQuote(branch: SessionEntry[], firstKeptEntryId: string): string {
	const entry = branch.find((candidate) => candidate?.id === firstKeptEntryId);
	if (!entry) throw new Error(`First kept entry ${firstKeptEntryId} is not on the branch.`);
	for (const message of sessionEntryToContextMessages(entry)) {
		const text = messageText(message).trim();
		if (text) return `${(message as { role: string }).role}: ${text.slice(0, 200)}`;
	}
	throw new Error(`First kept entry ${firstKeptEntryId} has no quotable content.`);
}

export default function registerTextCompaction(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const activeModel = ctx.model;
			const checkpoint = findNativeCheckpoint(event.branchEntries as SessionEntry[]);
			if (checkpoint.status !== "none" && isOpenAICodexModel(activeModel)) return;

			const config = getConfig();
			if (config.nativeCodex && isOpenAICodexModel(activeModel)) return;

			const model = activeModel;
			if (!model) {
				throw new Error("Cannot customize compaction without an active model.");
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const preparation = event.preparation;
			const branch = event.branchEntries as SessionEntry[];
			const boundary = findBoundaryQuote(branch, preparation.firstKeptEntryId);
			const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
			const instructions =
				buildSummaryInstructions({
					customInstructions: event.customInstructions,
					hasPreviousSummary: preparation.previousSummary !== undefined,
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
						onPayload: model.api === "anthropic-messages" ? cacheOnlyPreviousRequestPrefix : undefined,
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
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`Text compaction failed: ${errorMessage(error)}`, "error");
			}
			return { cancel: true };
		}
	});
}
