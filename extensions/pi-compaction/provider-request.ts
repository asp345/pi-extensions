import type { Api, Context, FetchFunction, Model, ThinkingLevel, Transport } from "@earendil-works/pi-ai";
import { sleep } from "@earendil-works/pi-ai/utils/sleep";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonObject } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;

export class RetryableResponseError extends Error {}

export function sessionReasoning(model: Model<Api>, level: string | undefined): ThinkingLevel | undefined {
	if (!model.reasoning || !level || level === "off") return undefined;
	return level as ThinkingLevel;
}

class RequestFailure extends Error {}

export interface ProviderRequest<T> {
	ctx: ExtensionContext;
	model: Model<Api>;
	context: Context;
	signal?: AbortSignal;
	maxTokens?: number;
	reasoning?: ThinkingLevel;
	transport?: Transport;
	headers?: Record<string, string>;
	editPayload: (payload: JsonObject) => JsonObject;
	readResponse: (response: Response) => Promise<T>;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
	const milliseconds = Number(response.headers.get("retry-after-ms"));
	if (response.headers.has("retry-after-ms") && Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function send<T>(
	input: Parameters<FetchFunction>[0],
	init: RequestInit,
	readResponse: (response: Response) => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		let wait: number | undefined;
		try {
			const response = await fetch(input, { ...init, signal });
			if (response.ok) return await readResponse(response);
			const text = await response.text().catch(() => "");
			const message = `Compaction request failed (${response.status}): ${text || response.statusText}`;
			if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) throw new RequestFailure(message);
			wait = retryAfterMs(response);
		} catch (error) {
			const retryable = error instanceof RetryableResponseError || error instanceof TypeError;
			if (error instanceof RequestFailure || signal.aborted || !retryable || attempt === MAX_ATTEMPTS) throw error;
		}
		await sleep(Math.min(wait ?? 1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS), signal);
	}
}

function handledResponse(): Response {
	return new Response(
		JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Sent by pi-compaction." } }),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

export async function requestThroughProvider<T>(request: ProviderRequest<T>): Promise<T> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
	let outcome: { value: T } | { error: unknown } | undefined;
	const message = await request.ctx.modelRegistry
		.streamSimple(request.model, request.context, {
			signal,
			sessionId: request.ctx.sessionManager.getSessionId(),
			maxTokens: request.maxTokens,
			maxRetries: 0,
			reasoning: request.reasoning,
			transport: request.transport,
			headers: request.headers,
			onPayload: (payload) => (isJsonObject(payload) ? request.editPayload(payload) : payload),
			fetch: async (input, init) => {
				try {
					outcome = { value: await send(input, init ?? {}, request.readResponse, signal) };
				} catch (error) {
					outcome = { error };
				}
				return handledResponse();
			},
		})
		.result();
	if (!outcome) throw new Error(message.errorMessage || "The provider did not send the compaction request.");
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}
