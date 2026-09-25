import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { getOpencodeSessionHeaders } from "./headers.ts";
import { isJsonObject, type JsonObject } from "./protocol.ts";

export const OPENAI_COMPLETIONS_API = "openai-completions";

const SUMMARY_TIMEOUT_MS = 300000;
const MAX_SUMMARY_ATTEMPTS = 3;

const snapshots = new Map<string, JsonObject>();
const summaryInFlight = new Set<string>();

export function isOpenAICompletionsModel(model: unknown): model is Model<"openai-completions"> {
	if (!isJsonObject(model)) return false;
	return (model as { api?: unknown }).api === OPENAI_COMPLETIONS_API;
}

export function recordOpenAIWireBody(sessionId: string, payload: unknown): void {
	if (summaryInFlight.has(sessionId)) return;
	if (!isJsonObject(payload)) return;
	if (!Array.isArray(payload.messages) || payload.messages.length === 0) return;
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) return;
	snapshots.set(sessionId, structuredClone(payload));
}

export function getOpenAIWireBody(sessionId: string): JsonObject | undefined {
	const snapshot = snapshots.get(sessionId);
	return snapshot ? structuredClone(snapshot) : undefined;
}

export function clearOpenAIWireSnapshots(): void {
	snapshots.clear();
	summaryInFlight.clear();
}

function resolveCompletionsUrl(baseUrl: string | undefined): string {
	const base = (
		typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl.trim() : "https://api.openai.com"
	).replace(/\/+$/, "");
	return `${base}/chat/completions`;
}

function sessionAffinityHeaders(model: Model<Api>, sessionId: string): Record<string, string> {
	const compat = model.compat as
		| { sendSessionAffinityHeaders?: boolean; sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter" }
		| undefined;
	const openRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	if (!(compat?.sendSessionAffinityHeaders ?? openRouter)) return {};
	const format = compat?.sessionAffinityFormat ?? (openRouter ? "openrouter" : "openai");
	if (format === "openrouter") return { "x-session-id": sessionId };
	return {
		...(format === "openai" ? { session_id: sessionId } : {}),
		"x-client-request-id": sessionId,
		"x-session-affinity": sessionId,
	};
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

export type OpenAISummaryRequest = {
	model: Model<Api>;
	apiKey: string;
	callerHeaders: Record<string, string>;
	sessionId: string;
	instruction: string;
	maxTokens: number;
	signal?: AbortSignal;
};

export type OpenAISummaryResult = {
	text: string;
	usage?: Usage;
};

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
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Summarization aborted"));
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function requestOpenAISummary(params: OpenAISummaryRequest): Promise<OpenAISummaryResult> {
	const wire = getOpenAIWireBody(params.sessionId);
	if (!wire) throw new Error("No recorded wire prefix for this session.");
	const messages = [...(wire.messages as unknown[]), { role: "user", content: params.instruction }];
	const body: JsonObject = {
		...wire,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};
	if (wire.max_completion_tokens !== undefined) {
		body.max_completion_tokens = params.maxTokens;
		delete body.max_tokens;
	} else {
		body.max_tokens = params.maxTokens;
		delete body.max_completion_tokens;
	}
	const headers: Record<string, string> = {
		accept: "text/event-stream",
		"content-type": "application/json",
		authorization: `Bearer ${params.apiKey}`,
		"x-client-request-id": crypto.randomUUID(),
		...sessionAffinityHeaders(params.model, params.sessionId),
		...getOpencodeSessionHeaders(params.model, params.sessionId),
		...params.callerHeaders,
	};
	const url = resolveCompletionsUrl(params.model.baseUrl);
	const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
	const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
	let lastError = "OpenAI summary request failed.";
	summaryInFlight.add(params.sessionId);
	try {
		for (let attempt = 0; attempt < MAX_SUMMARY_ATTEMPTS; attempt++) {
			try {
				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal,
				});
				if (!response.ok || !response.body) {
					const text = await response.text().catch(() => "");
					const retryable = isRetryableStatus(response.status);
					lastError = `OpenAI summary request failed (${response.status}): ${text || response.statusText}`;
					if (!retryable || attempt === MAX_SUMMARY_ATTEMPTS - 1) throw new Error(lastError);
					await delay(1000 * 2 ** attempt, params.signal);
					continue;
				}
				return await readSummaryStream(params.model, response.body, signal);
			} catch (error) {
				if (params.signal?.aborted) throw error;
				if (error instanceof Error && attempt < MAX_SUMMARY_ATTEMPTS - 1 && /failed \(\d{3}\)/.test(error.message)) {
					const status = Number((error.message.match(/failed \((\d{3})\)/) ?? [])[1] ?? 0);
					if (isRetryableStatus(status)) {
						lastError = error.message;
						await delay(1000 * 2 ** attempt, params.signal);
						continue;
					}
				}
				throw error;
			}
		}
	} finally {
		summaryInFlight.delete(params.sessionId);
	}
	throw new Error(lastError);
}

async function readSummaryStream(
	model: Model<Api>,
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): Promise<OpenAISummaryResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let sawToolCall = false;
	let usage: Usage | undefined;
	const pump = async (): Promise<void> => {
		while (true) {
			const { done, value } = await reader.read();
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Summarization aborted");
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const data = trimmed.slice(5).trim();
				if (data === "[DONE]") continue;
				let event: unknown;
				try {
					event = JSON.parse(data);
				} catch {
					continue;
				}
				if (!isJsonObject(event)) continue;
				const choices = event.choices;
				if (Array.isArray(choices)) {
					for (const choice of choices) {
						if (!isJsonObject(choice)) continue;
						const delta = choice.delta;
						if (!isJsonObject(delta)) continue;
						if (typeof delta.content === "string") text += delta.content;
						const message = choice.message;
						if (isJsonObject(message) && typeof message.content === "string") text += message.content;
						const deltaCalls = (delta as Record<string, unknown>).tool_calls;
						const messageCalls = message !== undefined && isJsonObject(message) ? message.tool_calls : undefined;
						if (
							(Array.isArray(deltaCalls) && deltaCalls.length > 0) ||
							(Array.isArray(messageCalls) && messageCalls.length > 0)
						) {
							sawToolCall = true;
						}
					}
				}
				const usageJson = event.usage;
				if (isJsonObject(usageJson)) {
					const parsed = parseUsage(model, usageJson);
					if (parsed) usage = parsed;
				}
			}
		}
	};
	try {
		await pump();
	} finally {
		reader.releaseLock();
	}
	if (sawToolCall) throw new Error("Text compaction attempted to call a tool");
	if (text.trim().length === 0) throw new Error("Text compaction returned an empty summary");
	return { text, usage };
}

function parseUsage(model: Model<Api>, usageJson: JsonObject): Usage | undefined {
	const input = usageJson.prompt_tokens;
	const output = usageJson.completion_tokens;
	if (typeof input !== "number" || typeof output !== "number") return undefined;
	const details = usageJson.prompt_tokens_details;
	const cacheRead = isJsonObject(details) && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
	const usage: Usage = {
		input: Math.max(0, input - cacheRead),
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
