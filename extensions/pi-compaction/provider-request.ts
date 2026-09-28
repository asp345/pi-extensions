import type { Api, Context, FetchFunction, Model, ThinkingLevel, Transport } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonObject } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 300_000;

export function sessionReasoning(model: Model<Api>, level: string | undefined): ThinkingLevel | undefined {
	if (!model.reasoning || !level || level === "off") return undefined;
	return level as ThinkingLevel;
}

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

async function send<T>(
	input: Parameters<FetchFunction>[0],
	init: RequestInit,
	readResponse: (response: Response) => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	const response = await fetch(input, { ...init, signal });
	if (response.ok) return readResponse(response);
	const text = await response.text().catch(() => "");
	throw new Error(`Compaction request failed (${response.status}): ${text || response.statusText}`);
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
