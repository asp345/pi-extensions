import { createHash } from "node:crypto";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
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
	isJsonObject,
	type JsonObject,
	type ResponseItem,
	responseItemText,
	truncateMessage,
} from "./protocol.ts";

const RETAINED_USER_TOKEN_BUDGET = 64_000;

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedItemId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.slice(0, 64)
		.replace(/_+$/, "");
	return sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`.slice(0, 64);
}

function textPhase(value: unknown): "commentary" | "final_answer" | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const parsed = JSON.parse(value) as JsonObject;
		return parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
	} catch {
		return undefined;
	}
}

function contentToUserParts(content: unknown): unknown[] {
	if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: unknown[] = [];
	for (const part of content) {
		if (!isJsonObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "input_text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			parts.push({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` });
		}
	}
	return parts;
}

function toolResultOutput(message: JsonObject, model: Model<Api>): unknown {
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.flatMap((part) => (isJsonObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
	const images = content.filter((part) => isJsonObject(part) && part.type === "image");
	if (images.length === 0 || !model.input.includes("image")) {
		return text || (images.length > 0 ? "(see attached image)" : "(no tool output)");
	}
	return [
		...(text ? [{ type: "input_text", text }] : []),
		...images.flatMap((part) =>
			typeof part.data === "string" && typeof part.mimeType === "string"
				? [{ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` }]
				: [],
		),
	];
}

function responseTool(tool: ToolInfo, deferLoading = false): JsonObject {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown,
		strict: null,
		...(deferLoading ? { defer_loading: true } : {}),
	};
}

function assistantTextItem(text: string, phase?: "commentary" | "final_answer"): ResponseItem {
	return {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
		...(phase ? { phase } : {}),
	};
}

function messagesToResponseItems(model: Model<Api>, messages: Message[], tools: ToolInfo[]): ResponseItem[] {
	const items: ResponseItem[] = [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const pendingToolCalls = new Map<string, string>();
	const flushOrphanedToolCalls = () => {
		for (const callId of pendingToolCalls.values()) {
			items.push({ type: "function_call_output", call_id: callId, output: "No result provided" });
		}
		pendingToolCalls.clear();
	};

	for (const message of messages as unknown as JsonObject[]) {
		if (message.role === "user") {
			flushOrphanedToolCalls();
			const content = contentToUserParts(message.content);
			if (content.length > 0) items.push({ role: "user", content });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			flushOrphanedToolCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const isSameProvider = message.provider === model.provider;
			for (const block of message.content) {
				if (!isJsonObject(block)) continue;
				if (block.type === "thinking") {
					if (isSameProvider && typeof block.thinkingSignature === "string") {
						try {
							const reasoning = JSON.parse(block.thinkingSignature);
							if (isJsonObject(reasoning) && reasoning.type === "reasoning") {
								items.push(cloneInputItem(reasoning));
								continue;
							}
						} catch {}
					}
					if (typeof block.thinking === "string" && block.thinking.trim()) {
						items.push(assistantTextItem(block.thinking));
					}
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					const phase = textPhase(block.textSignature);
					items.push(assistantTextItem(block.text, phase));
					continue;
				}
				if (block.type === "toolCall" && typeof block.id === "string") {
					const [callId, rawItemId] = block.id.split("|");
					const itemId = isSameProvider ? normalizedItemId(rawItemId) : undefined;
					pendingToolCalls.set(block.id, callId);
					items.push({
						type: "function_call",
						call_id: callId,
						...(itemId ? { id: itemId } : {}),
						name: String(block.name ?? ""),
						arguments: JSON.stringify(block.arguments ?? {}),
					});
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const [callId] = message.toolCallId.split("|");
			pendingToolCalls.delete(message.toolCallId);
			items.push({ type: "function_call_output", call_id: callId, output: toolResultOutput(message, model) });

			const addedTools = Array.isArray(message.addedToolNames)
				? message.addedToolNames.flatMap((name) => {
						if (typeof name !== "string") return [];
						const tool = toolsByName.get(name);
						return tool ? [tool] : [];
					})
				: [];
			if (addedTools.length > 0) {
				const searchCallId = `pi_tool_load_${shortHash(`${message.toolCallId}:${addedTools.map((tool) => tool.name).join(",")}`)}`;
				items.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					arguments: { query: addedTools.map((tool) => tool.name).join(" "), limit: addedTools.length },
				});
				items.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					tools: addedTools.map((tool) => responseTool(tool, true)),
				});
			}
		}
	}
	flushOrphanedToolCalls();

	return items;
}

function entriesToResponseItems(model: Model<Api>, entries: SessionEntry[], tools: ToolInfo[]): ResponseItem[] {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messagesToResponseItems(model, convertToLlm(messages), tools);
}

export function effectiveInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<Api>;
	tools: ToolInfo[];
	excludeLastAssistantError?: boolean;
}): ResponseItem[] {
	let branch = params.branch;
	if (params.excludeLastAssistantError) {
		const lastAssistantIndex = branch.findLastIndex(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (lastAssistantIndex >= 0) {
			branch = branch.filter((_entry, index) => index !== lastAssistantIndex);
		}
	}

	const checkpoint = findNativeCheckpoint(branch);
	if (checkpoint.status === "invalid") {
		throw new Error("The latest OpenAI Codex native compaction checkpoint is malformed.");
	}
	if (checkpoint.status === "valid") {
		const tail = branch.slice(checkpoint.checkpoint.entryIndex + 1);
		return [
			...checkpoint.checkpoint.details.replacementHistory.map(cloneInputItem),
			...entriesToResponseItems(params.model, tail, params.tools),
		];
	}

	const context = buildSessionContext(branch);
	return messagesToResponseItems(params.model, convertToLlm(context.messages), params.tools);
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

export function buildToolPayload(allTools: ToolInfo[], activeToolNames: string[]): unknown[] | undefined {
	const active = new Set(activeToolNames);
	const tools = allTools.filter((tool) => active.has(tool.name));
	return tools.length > 0 ? tools.map((tool) => responseTool(tool)) : undefined;
}
