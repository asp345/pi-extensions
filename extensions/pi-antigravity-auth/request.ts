import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	type AgyRequestScope,
	ANTIGRAVITY_ENDPOINT,
	buildAgyAgentRequestMetadata,
	buildAntigravityHarnessUserAgent,
	ensureProjectContext,
	fetchWithAgyCliTransport,
	orderAgyRequestPayloadInPlace,
} from "./agy/index.ts";
import { geminiRequest } from "./gemini.ts";
import { resolveModel } from "./model-tiers.ts";
import { refreshByAccessToken, requestSessions } from "./session.ts";

function finalize(request: Record<string, unknown>, model: string, scope: AgyRequestScope): string {
	const metadata = buildAgyAgentRequestMetadata(scope.session, request, model, scope.timestamp, {
		stepCountMode: "cli",
	});
	request.labels = metadata.labels;
	request.sessionId = metadata.sessionId;
	orderAgyRequestPayloadInPlace(request);
	return metadata.requestId;
}

export async function sendRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	accessToken: string,
	sessionKey: string,
	signal: AbortSignal,
): Promise<Response> {
	const resolved = resolveModel(model, options?.reasoning);
	const wireModel = resolved.actualModel;
	const project = await ensureProjectContext({
		type: "oauth",
		refresh: refreshByAccessToken.get(accessToken) ?? "",
		access: accessToken,
		expires: Date.now() + 60_000,
	});
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
		project: project.effectiveProjectId,
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
		"User-Agent": buildAntigravityHarnessUserAgent(),
		"Accept-Encoding": "gzip",
	});
	for (const [name, value] of Object.entries(options?.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	// The transport already retries TLS handshake failures; this loop covers
	// connection-level errors that surface after the handshake (ECONNRESET,
	// EPIPE) where the request may or may not have reached the server. Each
	// retry re-runs beginRequest so the requestId increments, matching agy CLI
	// behavior of a unique requestId per attempt.
	let response: Response | undefined;
	for (let attempt = 0; ; attempt += 1) {
		try {
			response = await fetchWithAgyCliTransport(
				`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(transformed),
				},
				{ signal },
			);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const transient = code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT";
			if (!transient || attempt >= 2 || signal.aborted) throw error;
		}
	}
	await options?.onResponse?.(
		{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
		model,
	);
	return response;
}
