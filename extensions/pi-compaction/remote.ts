import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { cloneItem, isJsonObject, isResponseItem, type JsonObject, type ResponseItem } from "./protocol.ts";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const MAX_REMOTE_RETRIES = 2;

type RemoteCompactionResult = {
	compactionItem: ResponseItem;
	usage?: Usage;
};

export function buildCompactionRequestBody(params: {
	basePayload?: JsonObject;
	model: Model<Api>;
	input: ResponseItem[];
	instructions: string;
	tools?: unknown[];
	sessionId: string;
}): JsonObject {
	const base = params.basePayload ? cloneItem(params.basePayload) : {};
	const previousText = isJsonObject(base.text) ? base.text : undefined;
	const include = Array.isArray(base.include)
		? [
				...new Set([
					...base.include.filter((value): value is string => typeof value === "string"),
					"reasoning.encrypted_content",
				]),
			]
		: ["reasoning.encrypted_content"];

	const body: JsonObject = {
		...base,
		model: params.model.id,
		store: false,
		stream: true,
		instructions: params.instructions,
		input: [...params.input.map(cloneItem), { type: "compaction_trigger" }],
		tool_choice: "auto",
		parallel_tool_calls: true,
		include,
		prompt_cache_key: params.sessionId,
		text:
			previousText && typeof previousText.verbosity === "string"
				? { verbosity: previousText.verbosity }
				: { verbosity: "low" },
	};
	if (params.tools) body.tools = params.tools;
	else delete body.tools;
	delete body.messages;
	delete body.previous_response_id;
	return body;
}

export function resolveCodexResponsesUrl(baseUrl?: string): string {
	const normalized = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const encoded = parts[1];
		if (!encoded) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as JsonObject;
		const auth = payload["https://api.openai.com/auth"];
		if (!isJsonObject(auth) || typeof auth.chatgpt_account_id !== "string") throw new Error("Missing account ID");
		return auth.chatgpt_account_id;
	} catch {
		throw new Error("Failed to extract the ChatGPT account ID from the OpenAI Codex token.");
	}
}

export function mergeFeatureHeader(existing: string | null | undefined): string {
	const features = (existing ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set([...features, REMOTE_COMPACTION_FEATURE])].join(",");
}

export function buildCodexHeaders(params: {
	apiKey: string;
	headers?: Record<string, string>;
	sessionId: string;
}): Headers {
	const headers = new Headers(params.headers);
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("chatgpt-account-id", extractCodexAccountId(params.apiKey));
	headers.set("originator", "pi");
	headers.set("user-agent", "pi-compaction");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	headers.set("session-id", params.sessionId);
	headers.set("x-client-request-id", params.sessionId);
	headers.set("x-codex-beta-features", mergeFeatureHeader(headers.get("x-codex-beta-features")));
	return headers;
}

function parseRetryDelay(response: Response): number | undefined {
	const milliseconds = Number(response.headers.get("retry-after-ms"));
	if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

class NonRetryableCompactionError extends Error {}
class RetryableCompactionStreamError extends Error {}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Compaction aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function parseSseResponse(response: Response): Promise<{ item: ResponseItem; usage?: unknown }> {
	if (!response.body) throw new Error("OpenAI Codex returned an empty compaction stream.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	let usage: unknown;
	const compactionItems: ResponseItem[] = [];

	const processBlock = (block: string) => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			throw new NonRetryableCompactionError("OpenAI Codex returned malformed compaction SSE data.");
		}
		if (!isJsonObject(event)) return;
		if (event.type === "error") {
			if (typeof event.message !== "string" || !event.message.trim()) {
				throw new RetryableCompactionStreamError("OpenAI Codex compaction failed.");
			}
			throw new NonRetryableCompactionError(event.message);
		}
		if (event.type === "response.failed") {
			throw new NonRetryableCompactionError("OpenAI Codex compaction ended with response.failed.");
		}
		if (event.type === "response.incomplete") {
			throw new RetryableCompactionStreamError("OpenAI Codex compaction ended with response.incomplete.");
		}
		if (event.type === "response.output_item.done" && isResponseItem(event.item) && event.item.type === "compaction") {
			compactionItems.push(event.item);
		}
		if (event.type === "response.completed" || event.type === "response.done") {
			completed = true;
			usage = isJsonObject(event.response) ? event.response.usage : undefined;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			processBlock(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) processBlock(buffer);
	if (!completed) {
		throw new RetryableCompactionStreamError("OpenAI Codex compaction stream closed before response.completed.");
	}
	if (compactionItems.length !== 1) {
		throw new NonRetryableCompactionError(
			`OpenAI Codex returned ${compactionItems.length} compaction items; expected exactly one.`,
		);
	}
	const item = compactionItems[0];
	if (!item || typeof item.encrypted_content !== "string") {
		throw new NonRetryableCompactionError("OpenAI Codex returned a compaction item without encrypted_content.");
	}
	return { item, usage };
}

function usageFromResponse(model: Model<Api>, value: unknown): Usage | undefined {
	if (!isJsonObject(value)) return undefined;
	const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
	const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
	const details = isJsonObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
	const cacheWrite = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

export async function callRemoteCompaction(params: {
	url: string;
	headers: Headers;
	body: JsonObject;
	model: Model<Api>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<RemoteCompactionResult> {
	const fetchImpl = params.fetchImpl ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_REMOTE_RETRIES; attempt++) {
		try {
			const response = await fetchImpl(params.url, {
				method: "POST",
				headers: params.headers,
				body: JSON.stringify(params.body),
				signal: params.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const message = `OpenAI Codex compaction failed (${response.status}): ${body || response.statusText}`;
				if (!isRetryableStatus(response.status)) throw new NonRetryableCompactionError(message);
				const error = new Error(message);
				if (attempt === MAX_REMOTE_RETRIES) throw error;
				lastError = error;
				await delay(parseRetryDelay(response) ?? 1000 * 2 ** attempt, params.signal);
				continue;
			}
			const parsed = await parseSseResponse(response);
			return { compactionItem: parsed.item, usage: usageFromResponse(params.model, parsed.usage) };
		} catch (error) {
			if (params.signal?.aborted || error instanceof NonRetryableCompactionError) throw error;
			lastError = error;
			if (attempt === MAX_REMOTE_RETRIES) throw error;
			await delay(1000 * 2 ** attempt, params.signal);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("OpenAI Codex compaction failed.");
}

export function stripInputFromPayload(payload: JsonObject): JsonObject {
	const shape = cloneItem(payload);
	delete shape.input;
	delete shape.messages;
	delete shape.previous_response_id;
	return shape;
}
