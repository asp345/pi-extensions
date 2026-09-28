import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import {
	type AgyRequestScope,
	ANTIGRAVITY_ENDPOINT,
	ANTIGRAVITY_USER_AGENT,
	buildAgyAgentRequestMetadata,
	fetchWithAgyCliTransport,
	orderAgyRequestPayloadInPlace,
} from "./agy/index.ts";
import { geminiRequest } from "./gemini.ts";
import { resolveModel } from "./model-tiers.ts";
import { refreshByAccessToken, requestSessions } from "./session.ts";

function finalize(request: Record<string, unknown>, model: string, scope: AgyRequestScope): string {
	const metadata = buildAgyAgentRequestMetadata(scope.session, request, model, scope.timestamp);
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
	const resolved = resolveModel(model, options?.reasoning);
	const wireModel = resolved.actualModel;
	const project = refreshByAccessToken.get(accessToken)?.split("|")[1];
	if (!project) throw new Error("Antigravity credentials have no project id. Run /login again.");
	const request = geminiRequest(context, model) as unknown as Record<string, unknown>;
	const generationConfig: Record<string, unknown> = {};
	if (typeof resolved.thinkingBudget === "number") {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
			thinkingBudget: resolved.thinkingBudget,
		};
	}
	const maxTokens = options?.maxTokens ?? model.maxTokens;
	if (typeof maxTokens === "number") generationConfig.maxOutputTokens = maxTokens;
	if (Object.keys(generationConfig).length) {
		request.generationConfig = generationConfig;
	}
	const requestId = finalize(request, wireModel, requestSessions.beginRequest(sessionKey));
	const payload = {
		project,
		requestId,
		request,
		model: wireModel,
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
