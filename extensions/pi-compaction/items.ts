import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getDeclaredTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	buildSessionContext,
	convertToLlm,
	type SessionEntry,
	sessionEntryToContextMessages,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { findNativeCheckpoint } from "./checkpoint.ts";
import {
	approximateTokens,
	cloneInputItem,
	cloneItem,
	type ResponseItem,
	responseItemText,
	truncateMessage,
} from "./protocol.ts";

const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const RETAINED_USER_TOKEN_BUDGET = 64_000;

interface ResponsesCompat {
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	supportsMidConvoSystemMessages?: boolean;
}

function responsesCompat(model: Model<Api>): ResponsesCompat {
	return model.compat ?? {};
}

function responsesToolOptions(model: Model<Api>): {
	strict: null;
	supportsStrictMode: boolean;
	supportsOpenAIGrammarTools: boolean;
} {
	const compat = responsesCompat(model);
	return {
		strict: null,
		supportsStrictMode: compat.supportsStrictMode ?? true,
		supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false,
	};
}

function toProviderItems(params: { model: Model<Api>; tools: ToolInfo[]; messages: Message[] }): ResponseItem[] {
	const compat = responsesCompat(params.model);
	const transcript = normalizeContext({
		tools: params.tools as unknown as Tool[],
		messages: params.messages,
	});
	return convertResponsesMessages(params.model, transcript, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties: createGrammarToolInputProperties(
			getDeclaredTools(transcript.messages),
			compat.supportsOpenAIGrammarTools ?? false,
		),
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools: compat.supportsAdditionalTools ?? false,
		supportsToolSearch: compat.supportsToolSearch ?? false,
		toolOptions: responsesToolOptions(params.model),
	}) as unknown as ResponseItem[];
}

function entriesToMessages(entries: SessionEntry[]): Message[] {
	return convertToLlm(entries.flatMap((entry) => sessionEntryToContextMessages(entry)));
}

export function effectiveInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<Api>;
	tools: ToolInfo[];
}): ResponseItem[] {
	const checkpoint = findNativeCheckpoint(params.branch);
	if (checkpoint.status === "invalid") {
		throw new Error("The latest OpenAI Codex native compaction checkpoint is malformed.");
	}
	if (checkpoint.status === "valid") {
		const tail = params.branch.slice(checkpoint.checkpoint.entryIndex + 1);
		return [
			...checkpoint.checkpoint.details.replacementHistory.map(cloneInputItem),
			...toProviderItems({ model: params.model, tools: params.tools, messages: entriesToMessages(tail) }),
		];
	}
	const context = buildSessionContext(params.branch);
	return toProviderItems({
		model: params.model,
		tools: params.tools,
		messages: convertToLlm(context.messages),
	});
}

function retainRecentUserMessages(items: ResponseItem[], maxTokens = RETAINED_USER_TOKEN_BUDGET): ResponseItem[] {
	let remaining = maxTokens;
	const retained: ResponseItem[] = [];
	for (const item of [...items].reverse()) {
		if (remaining <= 0) break;
		if ((item.type !== "message" && item.type !== undefined) || item.role !== "user" || !responseItemText(item).trim())
			continue;
		const tokens = approximateTokens(item);
		if (tokens <= remaining) {
			retained.push(cloneItem(item));
			remaining -= tokens;
			continue;
		}
		const truncated = truncateMessage(item, remaining);
		if (truncated) retained.push(truncated);
		remaining = 0;
	}
	return retained.reverse();
}

export function buildReplacementHistory(
	preCompactionInput: ResponseItem[],
	compactionItem: ResponseItem,
): ResponseItem[] {
	if (compactionItem.type !== "compaction" || typeof compactionItem.encrypted_content !== "string") {
		throw new Error("OpenAI Codex did not return a valid compaction item.");
	}
	return [...retainRecentUserMessages(preCompactionInput), cloneItem(compactionItem)];
}
