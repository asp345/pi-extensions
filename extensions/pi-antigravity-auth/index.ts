import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ThinkingLevel,
	type ThinkingLevelMap,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AgyModelDefinition,
	type AgyRequestScope,
	AgyRequestSessionStore,
	ANTIGRAVITY_ENDPOINT,
	ANTIGRAVITY_REDIRECT_URI,
	authorizeAntigravity,
	buildAgyAgentRequestMetadata,
	buildAntigravityHarnessUserAgent,
	ensureProjectContext,
	exchangeAntigravity,
	fetchWithAgyCliTransport,
	orderAgyRequestPayloadInPlace,
	refreshAntigravityToken,
	refreshModelCatalog,
	resolveModelForAntigravity,
	STATIC_MODEL_CATALOG,
	toGeminiSchema,
} from "./agy/index.ts";

const PROVIDER_ID = "antigravity";
const TRAILING_USAGE_TIMEOUT = 1_000;
const requestSessions = new AgyRequestSessionStore("");
const refreshByAccessToken = new Map<string, string>();

type GeminiPart =
	| { text: string; thought?: boolean; thoughtSignature?: string }
	| { inlineData: { mimeType: string; data: string } }
	| {
			functionCall: { name: string; args: Record<string, unknown>; id: string };
			thoughtSignature?: string;
	  }
	| {
			functionResponse: {
				name: string;
				response: Record<string, unknown>;
				id: string;
			};
	  };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiRequest = {
	contents: GeminiContent[];
	tools?: Array<{
		functionDeclarations: Array<{
			name: string;
			description: string;
			parameters?: unknown;
		}>;
	}>;
	systemInstruction?: { parts: GeminiPart[] };
};
type GeminiResponsePart = {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		name?: string;
		args?: Record<string, unknown>;
		id?: string;
	};
};
type GeminiChunk = {
	candidates?: Array<{
		content?: { parts?: GeminiResponsePart[] };
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		cachedContentTokenCount?: number;
		thoughtsTokenCount?: number;
	};
};

export function requestSessionKey(conversation: string, credential: string): string {
	const scope = createHash("sha256").update(credential).digest("hex").slice(0, 16);
	return `${scope}:${conversation}`;
}

function rememberRefresh(access: string, refresh: string): void {
	if (!access) return;
	refreshByAccessToken.delete(access);
	while (refreshByAccessToken.size >= 4) refreshByAccessToken.delete(refreshByAccessToken.keys().next().value!);
	refreshByAccessToken.set(access, refresh);
}

type Authorization = { code: string; state: string };

function parseAuthorization(input: string, fallbackState: string): Authorization | undefined {
	let code = input.trim();
	let state = fallbackState;
	try {
		const url = new URL(code);
		code = url.searchParams.get("code") ?? code;
		state = url.searchParams.get("state") ?? state;
	} catch {}
	return code ? { code, state } : undefined;
}

async function callbackServer(expectedState: string, signal?: AbortSignal) {
	const redirect = new URL(ANTIGRAVITY_REDIRECT_URI);
	const server = createServer();
	let settle!: (value?: Authorization) => void;
	const result = new Promise<Authorization | undefined>((resolve) => {
		settle = resolve;
	});
	const abort = () => settle();
	const timeout = setTimeout(abort, 5 * 60_000);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	server.on("request", (request, response) => {
		const url = new URL(request.url ?? "/", redirect);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (url.pathname !== redirect.pathname || !code || state !== expectedState) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Invalid Antigravity authorization callback.");
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(
			"<!doctype html><title>Authorization complete</title><h1>Authorization complete</h1><p>You can return to Pi.</p>",
		);
		settle({ code, state });
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(Number(redirect.port), redirect.hostname, resolve);
		});
	} catch (error) {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		server.close();
		throw error;
	}
	return {
		result,
		close: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			settle();
			server.closeAllConnections();
			server.close();
		},
	};
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const authorization = await authorizeAntigravity();
	const expectedState = new URL(authorization.url).searchParams.get("state") ?? "";
	let callback: Awaited<ReturnType<typeof callbackServer>> | undefined;
	let result: Authorization | undefined;
	try {
		callback = await callbackServer(expectedState, callbacks.signal);
	} catch {}

	callbacks.onAuth({
		url: authorization.url,
		instructions: callback
			? "Complete login in your browser, or paste the final callback URL."
			: "Paste the final callback URL after completing login.",
	});
	if (callback) {
		try {
			result = callbacks.onManualCodeInput
				? await Promise.race([
						callback.result,
						callbacks.onManualCodeInput().then((input) => parseAuthorization(input, expectedState)),
					])
				: await callback.result;
		} finally {
			callback.close();
		}
	}
	if (callbacks.signal?.aborted) throw new Error("Antigravity OAuth login aborted.");
	result ??= parseAuthorization(
		await callbacks.onPrompt({ message: "Paste the Antigravity OAuth callback URL or code:" }),
		expectedState,
	);
	if (!result) throw new Error("Missing Antigravity authorization code.");
	if (result.state !== expectedState) throw new Error("Antigravity OAuth state mismatch.");

	const exchanged = await exchangeAntigravity(result.code, result.state);
	if (exchanged.type !== "success") {
		throw new Error(`Antigravity OAuth exchange failed: ${exchanged.error}`);
	}
	return {
		refresh: exchanged.refresh,
		access: exchanged.access,
		expires: exchanged.expires,
	};
}

async function refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const separator = credentials.refresh.indexOf("|");
	const refreshToken = separator === -1 ? credentials.refresh : credentials.refresh.slice(0, separator);
	const project = separator === -1 ? "" : credentials.refresh.slice(separator);
	const result = await refreshAntigravityToken(refreshToken);
	return {
		refresh: `${result.refresh}${project}`,
		access: result.access,
		expires: result.expires,
	};
}

function userParts(content: Array<TextContent | ImageContent>): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push({ text: block.text.toWellFormed() });
		} else if (block.type === "image" && block.data) {
			parts.push({
				inlineData: { mimeType: block.mimeType, data: block.data },
			});
		}
	}
	return parts;
}

function assistantParts(message: AssistantMessage, preserveSignatures: boolean): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (preserveSignatures && block.thinking) {
				parts.push({
					text: block.thinking.toWellFormed(),
					thought: true,
					...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
				});
			}
		} else if (block.type === "text" && block.text.trim()) {
			parts.push({
				text: block.text.toWellFormed(),
				...(preserveSignatures && block.textSignature ? { thoughtSignature: block.textSignature } : {}),
			});
		} else if (block.type === "toolCall") {
			parts.push({
				functionCall: {
					name: block.name,
					args: block.arguments ?? {},
					id: block.id,
				},
				...(preserveSignatures && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
			});
		}
	}
	return parts;
}

function resultResponse(message: ToolResultMessage): Record<string, unknown> {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return message.isError ? { error: text || "Error" } : { output: text };
}

export function convertMessages(messages: Message[], target: Model<Api>): GeminiContent[] {
	const output: GeminiContent[] = [];
	const targetCalls = new Map<string, boolean>();
	const isTarget = (message: AssistantMessage) => message.provider === target.provider && message.model === target.id;

	for (const message of messages) {
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") targetCalls.set(block.id, isTarget(message));
		}
	}

	for (const message of messages) {
		if (!message) continue;
		if (message.role === "user") {
			const parts =
				typeof message.content === "string"
					? message.content.trim()
						? [{ text: message.content.toWellFormed() }]
						: []
					: userParts(message.content);
			if (parts.length) output.push({ role: "user", parts });
		} else if (message.role === "assistant") {
			const parts = assistantParts(message, isTarget(message));
			if (parts.length) output.push({ role: "model", parts });
		} else if (message.role === "toolResult") {
			const role = targetCalls.get(message.toolCallId) === true ? "user" : "model";
			const part: GeminiPart = {
				functionResponse: {
					name: message.toolName,
					response: resultResponse(message),
					id: message.toolCallId,
				},
			};
			const last = output.at(-1);
			if (last?.role === role && last.parts.every((item) => "functionResponse" in item)) {
				last.parts.push(part);
			} else {
				output.push({ role, parts: [part] });
			}
		}
	}
	return output;
}

function geminiRequest(context: Context, model: Model<Api>): GeminiRequest {
	return {
		contents: convertMessages(context.messages, model),
		...(context.tools?.length
			? {
					tools: [
						{
							functionDeclarations: context.tools.map((tool) => ({
								name: tool.name,
								description: tool.description,
								parameters: toGeminiSchema(tool.parameters),
							})),
						},
					],
				}
			: {}),
		...(context.systemPrompt?.trim()
			? { systemInstruction: { parts: [{ text: context.systemPrompt.toWellFormed() }] } }
			: {}),
	};
}

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

function updateUsage(model: Model<Api>, output: AssistantMessage, usage?: GeminiChunk["usageMetadata"]): void {
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

function unwrapChunk(value: unknown): GeminiChunk {
	if (value && typeof value === "object" && "response" in value) {
		const response = (value as { response?: unknown }).response;
		if (response && typeof response === "object") return response as GeminiChunk;
	}
	return value as GeminiChunk;
}

function payloadError(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || !("error" in value)) return undefined;
	const error = (value as { error?: unknown }).error;
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return JSON.stringify(error).slice(0, 500);
}

export async function* parseSse(response: Response): AsyncGenerator<GeminiChunk> {
	if (!response.body) throw new Error("Antigravity stream returned no response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parseFrame = (frame: string): GeminiChunk | undefined => {
		const lines = frame.split(/\r\n|\r|\n/u);
		const event = lines
			.find((line) => line.startsWith("event:"))
			?.slice(6)
			.trim();
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /u, ""))
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new Error(`Antigravity stream returned malformed SSE data: ${data.slice(0, 500)}`);
		}
		const chunk = unwrapChunk(parsed);
		const error = payloadError(parsed) ?? payloadError(chunk);
		if (event === "error" || error) throw new Error(`Antigravity stream error: ${error ?? data.slice(0, 500)}`);
		return chunk;
	};
	const nextBoundary = () => /(?:\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r)/u.exec(buffer);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = nextBoundary();
			while (boundary?.index !== undefined) {
				const chunk = parseFrame(buffer.slice(0, boundary.index));
				if (chunk) yield chunk;
				buffer = buffer.slice(boundary.index + boundary[0].length);
				boundary = nextBoundary();
			}
		}
		buffer += decoder.decode();
		const chunk = buffer.trim() ? parseFrame(buffer) : undefined;
		if (chunk) yield chunk;
	} finally {
		reader.releaseLock();
	}
}

// pi clamps requested levels to the model's advertised thinkingLevelMap before they
// reach this provider, so only the three suffix tiers antigravity supports are handled
// here; any other or missing level takes the header-style default path, which yields a
// valid model id.
export function resolveModel(model: Model<Api>, reasoning?: ThinkingLevel) {
	const id = model.id.toLowerCase();
	const tiered = model.reasoning && (id.includes("gemini-3") || (id.includes("claude") && id.includes("thinking")));
	const tier = reasoning === "low" || reasoning === "medium" || reasoning === "high" ? reasoning : undefined;
	if (!tiered || !tier) {
		return resolveModelForAntigravity(model.id);
	}
	const base = model.id.replace(/-(?:minimal|low|medium|high|xhigh)$/i, "");
	return resolveModelForAntigravity(base, tier);
}

function finalize(request: Record<string, unknown>, model: string, scope: AgyRequestScope): string {
	const metadata = buildAgyAgentRequestMetadata(scope.session, request, model, scope.timestamp, {
		stepCountMode: "cli",
	});
	request.labels = metadata.labels;
	request.sessionId = metadata.sessionId;
	orderAgyRequestPayloadInPlace(request);
	return metadata.requestId;
}

async function sendRequest(
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

function streamAntigravity(
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

// Antigravity's suffix vocabulary is low, medium, high. minimal and xhigh are internal
// aliases of low and high in resolveModel, and max has no representation, so none of
// them are advertised; pi clamps requests for them to the nearest supported level.
const TIER_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	low: "low",
	medium: "medium",
	high: "high",
	minimal: null,
	xhigh: null,
	max: null,
};

export default function antigravityAuth(pi: ExtensionAPI): void {
	const toProviderModels = (definitions: AgyModelDefinition[]) =>
		definitions.map((model) => ({
			id: model.id.replace(/^antigravity-/, ""),
			name: model.name,
			reasoning: model.reasoning,
			thinkingLevelMap: model.reasoning ? { ...TIER_THINKING_LEVEL_MAP } : undefined,
			input: model.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	const models = toProviderModels(STATIC_MODEL_CATALOG);
	const provider: Parameters<ExtensionAPI["registerProvider"]>[1] = {
		name: "Google Antigravity",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		api: "google-generative-ai",
		models,
		oauth: {
			name: "Google Antigravity",
			usesCallbackServer: true,
			login,
			refreshToken: refresh,
			getApiKey: (credentials: OAuthCredentials) => {
				rememberRefresh(credentials.access, credentials.refresh);
				// Refresh the model catalog in the background so new releases appear
				// without code changes; failures keep the current catalog.
				void refreshModelCatalog(credentials.access).then(
					(definitions) => {
						provider.models = toProviderModels(definitions);
					},
					() => {},
				);
				return credentials.access;
			},
		},
		streamSimple: streamAntigravity,
	};
	pi.registerProvider(PROVIDER_ID, provider);
}
