import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { GeminiResponsePart } from "./gemini.ts";
import { sendRequest } from "./request.ts";
import { refreshByAccessToken, requestSessionKey, requestSessions } from "./session.ts";
import { parseSse } from "./sse.ts";

const TRAILING_USAGE_TIMEOUT = 1_000;

const ERROR_FINISH_REASONS: Record<string, string> = {
	SAFETY: "Response blocked by safety filters",
	RECITATION: "Response blocked for recitation",
	LANGUAGE: "Response blocked for unsupported language",
	BLOCKLIST: "Response blocked by content blocklist",
	PROHIBITED_CONTENT: "Response blocked for prohibited content",
	SPII: "Response blocked for sensitive personal information",
	IMAGE_SAFETY: "Response blocked by image safety filters",
	MALFORMED_FUNCTION_CALL: "Model generated a malformed function call",
	UNEXPECTED_TOOL_CALL: "Model generated an unexpected tool call",
	OTHER: "Response stopped for an unspecified reason",
};

function applyFinishReason(output: AssistantMessage, reason: string): void {
	if (reason === "STOP" || reason === "MAX_TOKENS") {
		if (output.stopReason !== "toolUse") {
			output.stopReason = reason === "MAX_TOKENS" ? "length" : "stop";
		}
		return;
	}
	const description = ERROR_FINISH_REASONS[reason] ?? "Unrecognized finish reason";
	output.stopReason = "error";
	output.errorMessage = `${description} (finishReason: ${reason})`;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function updateUsage(
	model: Model<Api>,
	output: AssistantMessage,
	usage?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		cachedContentTokenCount?: number;
		thoughtsTokenCount?: number;
	},
): void {
	if (!usage) return;
	const cache = usage.cachedContentTokenCount ?? output.usage.cacheRead;
	const prompt = usage.promptTokenCount ?? output.usage.input + output.usage.cacheRead;
	output.usage.input = Math.max(0, prompt - cache);
	if (usage.candidatesTokenCount !== undefined || usage.thoughtsTokenCount !== undefined) {
		output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
	}
	output.usage.cacheRead = cache;
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

async function nextChunk<T>(iterator: AsyncIterator<T>, onTimeout: () => void): Promise<IteratorResult<T> | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			iterator.next(),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => {
					onTimeout();
					resolve(undefined);
				}, TRAILING_USAGE_TIMEOUT);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function toToolCall(part: GeminiResponsePart, pending: { signature?: string }): ToolCall | undefined {
	if (part.thought && !part.text && part.thoughtSignature) {
		pending.signature = part.thoughtSignature;
	}
	if (!part.functionCall) return undefined;
	const signature = part.thoughtSignature ?? pending.signature;
	pending.signature = undefined;
	return {
		type: "toolCall",
		id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
		name: part.functionCall.name ?? "",
		arguments: part.functionCall.args ?? {},
		...(signature ? { thoughtSignature: signature } : {}),
	};
}

export function streamAntigravity(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = createOutput(model);
		let response: Response | undefined;
		stream.push({ type: "start", partial: output });
		try {
			const accessToken = options?.apiKey;
			if (!accessToken) throw new Error("Missing Antigravity OAuth access token");
			const conversationKey =
				options?.sessionId ??
				(context.messages[0]?.timestamp !== undefined ? `message:${context.messages[0].timestamp}` : "__default__");
			const credential = refreshByAccessToken.get(accessToken) || accessToken;
			const sessionKey = requestSessionKey(conversationKey, credential);
			const trailingAbort = new AbortController();
			const signal = options.signal ? AbortSignal.any([options.signal, trailingAbort.signal]) : trailingAbort.signal;
			response = await sendRequest(model, context, options, accessToken, sessionKey, signal);
			if (!response.ok) {
				throw new Error(`Antigravity request failed: HTTP ${response.status} ${await response.text()}`);
			}

			const content = output.content as Array<TextContent | ThinkingContent | ToolCall>;
			const pending: { signature?: string } = {};
			let openIndex = -1;
			let terminal = false;
			const closeOpen = () => {
				if (openIndex === -1) return;
				const block = content[openIndex];
				if (block?.type === "text") {
					stream.push({ type: "text_end", contentIndex: openIndex, content: block.text, partial: output });
				} else if (block?.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex: openIndex, content: block.thinking, partial: output });
				}
				openIndex = -1;
			};
			const openBlock = (type: "text" | "thinking", signature?: string) => {
				if (content[openIndex]?.type === type) return;
				closeOpen();
				content.push(
					type === "thinking"
						? { type: "thinking", thinking: "", ...(signature ? { thinkingSignature: signature } : {}) }
						: { type: "text", text: "", ...(signature ? { textSignature: signature } : {}) },
				);
				openIndex = content.length - 1;
				stream.push({ type: `${type}_start`, contentIndex: openIndex, partial: output });
			};

			const iterator = parseSse(response)[Symbol.asyncIterator]();
			while (true) {
				const next = terminal ? await nextChunk(iterator, () => trailingAbort.abort()) : await iterator.next();
				if (!next || next.done) break;
				const chunk = next.value;
				updateUsage(model, output, chunk.usageMetadata);
				if (terminal) {
					if (chunk.usageMetadata) break;
					continue;
				}
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (!part.thought && !part.functionCall && !part.text && part.thoughtSignature) {
						const block = openIndex === -1 ? undefined : content[openIndex];
						if (block?.type === "text") block.textSignature = part.thoughtSignature;
						else pending.signature = part.thoughtSignature;
						continue;
					}
					const toolCall = toToolCall(part, pending);
					if (toolCall) {
						closeOpen();
						content.push(toolCall);
						const index = content.length - 1;
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
						output.stopReason = "toolUse";
					} else if (part.thought && part.text) {
						openBlock("thinking", part.thoughtSignature);
						const block = content[openIndex];
						if (block?.type === "thinking") {
							block.thinking += part.text;
							if (part.thoughtSignature) block.thinkingSignature = part.thoughtSignature;
							stream.push({ type: "thinking_delta", contentIndex: openIndex, delta: part.text, partial: output });
						}
					} else if (part.text) {
						if (content[openIndex]?.type !== "text") {
							const signature = part.thoughtSignature ?? pending.signature;
							pending.signature = undefined;
							openBlock("text", signature);
						}
						const block = content[openIndex];
						if (block?.type === "text") {
							block.text += part.text;
							if (part.thoughtSignature) block.textSignature = part.thoughtSignature;
							stream.push({ type: "text_delta", contentIndex: openIndex, delta: part.text, partial: output });
						}
					}
				}
				if (candidate?.finishReason) {
					closeOpen();
					applyFinishReason(output, candidate.finishReason);
					terminal = true;
					if (!model.id.toLowerCase().includes("gpt-oss") || chunk.usageMetadata) {
						break;
					}
				}
			}
			if (!terminal) {
				closeOpen();
				throw new Error("Antigravity stream ended without a finish reason");
			}
			if (terminal) {
				try {
					await iterator.return?.(undefined);
				} catch (error) {
					if (!trailingAbort.signal.aborted) throw error;
				}
				await response.body?.cancel().catch(() => {});
			}
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error") {
				stream.push({ type: "error", reason: "error", error: output });
			} else {
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				if (output.stopReason === "stop" || output.stopReason === "length") {
					requestSessions.completeExecution(sessionKey);
				}
			}
			stream.end();
		} catch (error) {
			await response?.body?.cancel().catch(() => {});
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}
