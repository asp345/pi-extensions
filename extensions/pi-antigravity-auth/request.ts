import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_USER_AGENT } from "./constants.ts";
import { geminiRequest } from "./gemini.ts";
import { resolveModel } from "./model-resolver.ts";
import type { AgyTierSpec } from "./models.ts";
import {
	type AgyRequestScope,
	buildAgyAgentRequestMetadata,
	orderAgyRequestPayloadInPlace,
} from "./request-metadata.ts";
import { refreshByAccessToken, requestSessions } from "./session.ts";
import { fetchWithAgyCliTransport } from "./transport.ts";

function finalize(request: Record<string, unknown>, tier: AgyTierSpec, scope: AgyRequestScope): string {
	const metadata = buildAgyAgentRequestMetadata(
		scope.session,
		request,
		tier.wireModel,
		tier.modelEnum,
		scope.timestamp,
	);
	request.labels = metadata.labels;
	request.sessionId = metadata.sessionId;
	orderAgyRequestPayloadInPlace(request);
	return metadata.requestId;
}

export async function sendRequest(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	accessToken: string,
	sessionKey: string,
	signal: AbortSignal,
): Promise<Response> {
	const tier = resolveModel(model, options?.reasoning);
	const project = refreshByAccessToken.get(accessToken)?.split("|")[1];
	if (!project) throw new Error("Antigravity credentials have no project id. Run /login again.");
	const request = geminiRequest(context, model) as unknown as Record<string, unknown>;
	const generationConfig: Record<string, unknown> = {};
	const maxTokens = options?.maxTokens ?? model.maxTokens;
	if (typeof maxTokens === "number") generationConfig.maxOutputTokens = maxTokens;
	if (tier.thinkingBudget !== undefined) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
			thinkingBudget: tier.thinkingBudget,
			...(tier.thinkingLevel ? { thinkingLevel: tier.thinkingLevel } : {}),
		};
	}
	if (Object.keys(generationConfig).length) {
		request.generationConfig = generationConfig;
	}
	const requestId = finalize(request, tier, requestSessions.beginRequest(sessionKey));
	const payload = {
		project,
		requestId,
		request,
		model: tier.wireModel,
		userAgent: "antigravity",
		requestType: "agent",
	};
	const transformed = (await options?.onPayload?.(payload, model)) ?? payload;
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": ANTIGRAVITY_USER_AGENT,
		"Accept-Encoding": "gzip",
	});
	for (const [name, value] of Object.entries(options?.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	const response = await fetchWithAgyCliTransport(
		`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(transformed),
		},
		{ signal },
	);
	await options?.onResponse?.(
		{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
		model,
	);
	return response;
}
