import { createHash } from "node:crypto";
import {
	type AgyRequestScope,
	AgyRequestSessionStore,
	ANTIGRAVITY_ENDPOINT,
	authorizeAntigravity,
	buildAgyAgentRequestMetadata,
	buildAntigravityHarnessUserAgent,
	ensureProjectContext,
	exchangeAntigravity,
	fetchWithAgyCliTransport,
	getPublicModelDefinitions,
	orderAgyRequestPayloadInPlace,
	refreshAntigravityToken,
	resolveModelForHeaderStyle,
	toGeminiSchema,
} from "@cortexkit/antigravity-auth-core";
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
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "google-antigravity";
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

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const authorization = await authorizeAntigravity();
	callbacks.onAuth({ url: authorization.url });
	const input = await callbacks.onPrompt({
		message: "Paste the Antigravity OAuth callback URL or code:",
	});
	let code = input.trim();
	let state = new URL(authorization.url).searchParams.get("state") ?? "";
	try {
		const url = new URL(code);
		code = url.searchParams.get("code") ?? code;
		state = url.searchParams.get("state") ?? state;
	} catch {}
	const result = await exchangeAntigravity(code, state);
	if (result.type !== "success") {
		throw new Error(`Antigravity OAuth exchange failed: ${result.error}`);
	}
	return {
		refresh: result.refresh,
		access: result.access,
		expires: result.expires,
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

function convertMessages(messages: Message[], target: Model<Api>): GeminiContent[] {
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
			const role = targetCalls.get(message.toolCallId) === true ? "model" : "user";
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
		stopReason: "stop",
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

function resolveModel(model: Model<Api>, reasoning?: ThinkingLevel) {
	const id = model.id.toLowerCase();
	const supportsTiers =
		model.reasoning && (id.includes("gemini-3") || (id.includes("claude") && id.includes("thinking")));
	if (!supportsTiers || !reasoning) {
		return resolveModelForHeaderStyle(model.id, "antigravity");
	}
	const tier = reasoning === "minimal" ? "low" : reasoning === "xhigh" ? "high" : reasoning;
	const base = model.id.replace(/-(minimal|low|medium|high|xhigh)$/i, "");
	return resolveModelForHeaderStyle(`${base}-${tier}`, "antigravity");
}

function finalize(request: Record<string, unknown>, model: string, scope: AgyRequestScope): string {
	if (Array.isArray(request.tools) && request.tools.length) {
		request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
	}
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
	if (resolved.thinkingLevel) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
			thinkingLevel: resolved.thinkingLevel,
		};
	} else if (typeof resolved.thinkingBudget === "number") {
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
	return fetchWithAgyCliTransport(
		`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": buildAntigravityHarnessUserAgent(),
				"Accept-Encoding": "gzip",
			},
			body: JSON.stringify({
				project: project.effectiveProjectId,
				requestId,
				request,
				model: wireModel,
				userAgent: "antigravity",
				requestType: "agent",
			}),
		},
		{ signal },
	);
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
			const response = await sendRequest(model, context, options, accessToken, sessionKey, signal);
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
			if (!terminal && content.length === 0) throw new Error("Antigravity stream ended without a model response");
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
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

export default function antigravityAuth(pi: ExtensionAPI): void {
	const models = Object.values(getPublicModelDefinitions())
		.filter((model) => !model.modalities.output.includes("image"))
		.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.limit.context,
			maxTokens: model.limit.output,
		}));
	pi.registerProvider(PROVIDER_ID, {
		name: "Google Antigravity",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		api: "google-generative-ai",
		models,
		oauth: {
			name: "Google Antigravity",
			login,
			refreshToken: refresh,
			getApiKey: (credentials: OAuthCredentials) => {
				rememberRefresh(credentials.access, credentials.refresh);
				return credentials.access;
			},
		},
		streamSimple: streamAntigravity,
	});
}
