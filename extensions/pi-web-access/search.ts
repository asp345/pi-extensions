import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	ANTIGRAVITY_ENDPOINT,
	buildAntigravityHarnessUserAgent,
	ensureProjectContext,
	fetchWithAgyCliTransport,
	resolveModelForHeaderStyle,
} from "@cortexkit/antigravity-auth-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, readWebConfig } from "./security.ts";
import {
	boundedText,
	combinedSignal,
	errorMessage,
	type QueryResult,
	readBytes,
	type SearchResult,
} from "./storage.ts";

export type SearchBackend = "openai" | "gemini" | "antigravity";
export type SearchProvider = "auto" | SearchBackend;
export type Recency = "day" | "week" | "month" | "year";
export interface SearchOptions {
	provider?: SearchProvider;
	limit?: number;
	recency?: Recency;
	domains?: string[];
	signal?: AbortSignal;
	context?: ExtensionContext;
}

const SEARCH_BACKENDS = ["openai", "gemini", "antigravity"] as const satisfies readonly SearchBackend[];
const DEFAULT_PROVIDER_ORDER: SearchBackend[] = ["openai", "gemini", "antigravity"];

const OPENAI_URL = "https://api.openai.com/v1/responses";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const GEMINI_HOST = "https://generativelanguage.googleapis.com";
const GOOGLE_PROVIDER = "google";
const ANTIGRAVITY_PROVIDER = "google-antigravity";
const ANTIGRAVITY_MODEL = "gemini-3.6-flash";
const ANTIGRAVITY_SEARCH_SYSTEM =
	"You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.";
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const OPENAI_MODELS = [
	{
		provider: "openai-codex",
		ids: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2"],
	},
	{
		provider: "openai",
		ids: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4", "gpt-5.2", "gpt-4.1-mini", "gpt-4o"],
	},
] as const;
const OPENAI_SEARCH_MODEL = "gpt-5.6-luna";
const OPENAI_SEARCH_REASONING_EFFORT = "high";
const GEMINI_SEARCH_MODEL = "gemini-3.5-flash-lite";

interface OpenAIAuth {
	key: string;
	model: string;
	codex: boolean;
	headers: Record<string, string>;
}
interface AntigravityAuth {
	access: string;
}
interface GeminiAuth {
	key?: string;
	gatewayKey?: string;
	headers?: Record<string, string>;
}
interface GeminiResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: unknown }> };
		groundingMetadata?: {
			groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
			groundingSupports?: Array<{ segment?: { endIndex?: number }; groundingChunkIndices?: number[] }>;
		};
	}>;
}

interface SearchConfig {
	provider?: unknown;
	providerOrder?: unknown;
	openaiApiKey?: unknown;
	openaiSearchModel?: unknown;
	geminiApiKey?: unknown;
	geminiBaseUrl?: unknown;
	geminiSearchModel?: unknown;
	antigravitySearchModel?: unknown;
	cloudflareApiKey?: unknown;
}

export async function search(query: string, options: SearchOptions = {}): Promise<QueryResult> {
	const provider = options.provider ?? configProvider() ?? "auto";
	if (provider !== "auto") {
		return { query, provider, ...(await runBackend(provider, query, options)) };
	}

	const attempts = await buildAutoAttempts(query, options);
	const errors: string[] = [];
	for (const attempt of attempts) {
		try {
			return { query, provider: attempt.provider, ...(await attempt.run()) };
		} catch (error) {
			if (aborted(error, options.signal)) throw error;
			errors.push(`${attempt.label}: ${errorMessage(error)}`);
		}
	}
	if (errors.length) throw new Error(`Automatic search failed. ${errors.join("; ")}`);
	throw new Error(
		`No search provider is available. Use /login for OpenAI or Google Antigravity, or set OPENAI_API_KEY or GEMINI_API_KEY (config: ${configPath()}).`,
	);
}

async function runBackend(
	provider: SearchBackend,
	query: string,
	options: SearchOptions,
	resolved?: { openAI?: OpenAIAuth; gemini?: GeminiAuth; antigravity?: AntigravityAuth },
): Promise<{ answer: string; results: SearchResult[] }> {
	if (provider === "openai") return searchOpenAI(query, options, resolved?.openAI);
	if (provider === "gemini") return searchGeminiApi(query, options, resolved?.gemini);
	const antigravity = resolved?.antigravity ?? (await resolvePiAntigravity(options.context));
	if (!antigravity) {
		throw new Error(
			`Antigravity search is not configured. Use /login for Google Antigravity (config: ${configPath()}).`,
		);
	}
	return searchAntigravity(query, options, antigravity);
}

async function buildAutoAttempts(
	query: string,
	options: SearchOptions,
): Promise<
	Array<{ provider: SearchBackend; label: string; run: () => Promise<{ answer: string; results: SearchResult[] }> }>
> {
	const openAI = await resolveOpenAI(options.context, options.signal);
	const gemini = await resolveGeminiAuth(options.context);
	const antigravity = await resolvePiAntigravity(options.context);
	const attempts: Array<{
		provider: SearchBackend;
		label: string;
		run: () => Promise<{ answer: string; results: SearchResult[] }>;
	}> = [];
	for (const backend of configProviderOrder()) {
		if (backend === "openai") {
			if (!openAI) continue;
			attempts.push({
				provider: "openai",
				label: "OpenAI",
				run: () => runBackend("openai", query, options, { openAI }),
			});
			continue;
		}
		if (backend === "gemini") {
			if (!gemini) continue;
			attempts.push({
				provider: "gemini",
				label: "Gemini",
				run: () => runBackend("gemini", query, options, { gemini }),
			});
			continue;
		}
		if (!antigravity) continue;
		attempts.push({
			provider: "antigravity",
			label: "Antigravity",
			run: () => runBackend("antigravity", query, options, { antigravity }),
		});
	}
	return attempts;
}

export async function geminiAvailable(context?: ExtensionContext): Promise<boolean> {
	return Boolean((await resolveGeminiAuth(context)) || (await resolvePiAntigravity(context)));
}

export async function geminiApiKeyAvailable(context?: ExtensionContext): Promise<boolean> {
	return Boolean(await resolveGeminiAuth(context));
}

export async function geminiGenerate(
	parts: unknown[],
	options: { model?: string; signal?: AbortSignal; timeoutMs?: number; context?: ExtensionContext } = {},
): Promise<string> {
	const gemini = await resolveGeminiAuth(options.context);
	const antigravity = await resolvePiAntigravity(options.context);
	const errors: string[] = [];
	for (const backend of configProviderOrder()) {
		if (backend === "openai") continue;
		if (backend === "gemini") {
			if (!gemini) continue;
			try {
				return await geminiGenerateApi(parts, options, gemini);
			} catch (error) {
				if (aborted(error, options.signal)) throw error;
				errors.push(`Gemini: ${errorMessage(error)}`);
			}
			continue;
		}
		if (!antigravity) continue;
		try {
			return await geminiGenerateAntigravity(parts, options, antigravity);
		} catch (error) {
			if (aborted(error, options.signal)) throw error;
			errors.push(`Antigravity: ${errorMessage(error)}`);
		}
	}
	if (errors.length) throw new Error(errors.join("; "));
	throw new Error(
		`Gemini generation is not configured. Use /login for Google or Google Antigravity, or set GEMINI_API_KEY (config: ${configPath()}).`,
	);
}

async function geminiGenerateApi(
	parts: unknown[],
	options: { model?: string; signal?: AbortSignal; timeoutMs?: number; context?: ExtensionContext },
	auth: GeminiAuth,
): Promise<string> {
	const config = searchConfig();
	const model = geminiModel(config, options.model);
	const response = await geminiRequest<GeminiResponse>(
		`/v1beta/models/${encodeURIComponent(model)}:generateContent`,
		{
			contents: [{ role: "user", parts }],
		},
		{
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 120_000,
			context: options.context,
			auth,
		},
	);
	const text = candidateText(response.candidates?.[0]);
	if (!text) throw new Error("Gemini API returned no text");
	return text;
}

async function geminiGenerateAntigravity(
	parts: unknown[],
	options: { model?: string; signal?: AbortSignal; timeoutMs?: number },
	auth: AntigravityAuth,
): Promise<string> {
	const config = searchConfig();
	const model = antigravityWireModel(options.model ?? secret(config.antigravitySearchModel) ?? ANTIGRAVITY_MODEL);
	const project = await ensureProjectContext({
		type: "oauth",
		refresh: "",
		access: auth.access,
		expires: Date.now() + 60_000,
	});
	const body = {
		project: project.effectiveProjectId,
		request: {
			contents: [{ role: "user", parts }],
			generationConfig: { candidateCount: 1 },
		},
		model,
		userAgent: "antigravity",
		requestType: "agent",
	};
	try {
		const response = await fetchWithAgyCliTransport(
			`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.access}`,
					"Content-Type": "application/json",
					"User-Agent": buildAntigravityHarnessUserAgent(),
					"Accept-Encoding": "gzip",
				},
				body: JSON.stringify(body),
			},
			{ signal: combinedSignal(options.signal, options.timeoutMs ?? 120_000) },
		);
		const text = await readLimited(response, MAX_API_RESPONSE_BYTES);
		if (!response.ok)
			throw new Error(`Antigravity generation error ${response.status}: ${redact(text, [auth.access]).slice(0, 500)}`);
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			throw new Error("Antigravity generation returned invalid JSON");
		}
		const payloadError = antigravityPayloadError(parsed);
		if (payloadError) throw new Error(`Antigravity generation error: ${payloadError}`);
		const answer = candidateText(unwrapGeminiResponse(parsed).candidates?.[0]);
		if (!answer) throw new Error("Antigravity generation returned no text");
		return answer;
	} catch (error) {
		const clean = redact(errorMessage(error), [auth.access]);
		if (clean === errorMessage(error)) throw error;
		throw new Error(clean);
	}
}

async function geminiRequest<T = Record<string, unknown>>(
	pathOrUrl: string,
	body: unknown,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		method?: string;
		extraHeaders?: Record<string, string>;
		context?: ExtensionContext;
		auth?: GeminiAuth;
	} = {},
): Promise<T> {
	const config = searchConfig();
	const base = geminiBase(config);
	const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(pathOrUrl.replace(/^\//, ""), `${base}/`);
	if ([...url.searchParams.keys()].some((name) => /^(key|api_key)$/i.test(name)))
		throw new Error("Gemini credentials are not allowed in URLs");
	const baseOrigin = new URL(base).origin;
	if (url.origin !== baseOrigin && url.origin !== new URL(GEMINI_HOST).origin)
		throw new Error("Gemini API request host is not allowed");
	const auth = options.auth ?? (await resolveGeminiAuth(options.context));
	const key = auth?.key;
	const gatewayKey = auth?.gatewayKey;
	if (!key && !gatewayKey) {
		throw new Error(
			`Gemini API is not configured. Use /login for Google, set GEMINI_API_KEY, or add geminiApiKey (config: ${configPath()}).`,
		);
	}
	const headers = new Headers({
		"Content-Type": "application/json",
		...(auth?.headers ?? {}),
		...(options.extraHeaders ?? {}),
	});
	if (base.includes("gateway.ai.cloudflare.com")) {
		if (gatewayKey) headers.set("cf-aig-authorization", `Bearer ${gatewayKey}`);
	} else if (key) headers.set("x-goog-api-key", key);
	try {
		const response = await fetch(url, {
			method: options.method ?? "POST",
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: combinedSignal(options.signal, options.timeoutMs ?? 60_000),
		});
		const text = await readLimited(response, MAX_API_RESPONSE_BYTES);
		if (!response.ok)
			throw new Error(`Gemini API error ${response.status}: ${redact(text, [key, gatewayKey]).slice(0, 500)}`);
		try {
			return (text ? JSON.parse(text) : {}) as T;
		} catch {
			throw new Error("Gemini API returned invalid JSON");
		}
	} catch (error) {
		const clean = redact(errorMessage(error), [key, gatewayKey]);
		if (clean === errorMessage(error)) throw error;
		throw new Error(clean);
	}
}

export async function geminiUploadVideo(
	filePath: string,
	mimeType: string,
	signal?: AbortSignal,
	context?: ExtensionContext,
): Promise<{ uri: string; cleanup: () => Promise<void> }> {
	const config = searchConfig();
	const auth = await resolveGeminiAuth(context);
	const key = auth?.key;
	if (!key) {
		throw new Error(
			"A Gemini API key is required for local video upload. Use /login for Google or set GEMINI_API_KEY.",
		);
	}
	const base = geminiBase(config);
	const origin = new URL(base).origin;
	const bytes = await readFile(filePath);
	const start = await fetch(new URL("upload/v1beta/files", `${base}/`), {
		method: "POST",
		headers: {
			"x-goog-api-key": key,
			"x-goog-upload-protocol": "resumable",
			"x-goog-upload-command": "start",
			"x-goog-upload-header-content-length": String(bytes.length),
			"x-goog-upload-header-content-type": mimeType,
			"content-type": "application/json",
		},
		body: JSON.stringify({ file: { display_name: basename(filePath) } }),
		signal: combinedSignal(signal, 30_000),
	});
	if (!start.ok) throw new Error(`Gemini upload initialization failed: ${start.status}`);
	const uploadUrl = start.headers.get("x-goog-upload-url");
	if (!uploadUrl || new URL(uploadUrl).origin !== origin) throw new Error("Gemini returned an invalid upload URL");
	const upload = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"x-goog-api-key": key,
			"content-length": String(bytes.length),
			"x-goog-upload-offset": "0",
			"x-goog-upload-command": "upload, finalize",
		},
		body: bytes,
		signal: combinedSignal(signal, 120_000),
	});
	const uploadText = await readLimited(upload, MAX_API_RESPONSE_BYTES);
	if (!upload.ok) throw new Error(`Gemini upload failed ${upload.status}: ${redact(uploadText, [key]).slice(0, 300)}`);
	const file = JSON.parse(uploadText).file as { name: string; uri: string };
	if (!file?.name || !file.uri) throw new Error("Gemini upload returned invalid file metadata");
	const metadataUrl = new URL(`v1beta/${file.name}`, `${base}/`).toString();
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Aborted");
		const response = await fetch(metadataUrl, {
			headers: { "x-goog-api-key": key },
			signal: combinedSignal(signal, 15_000),
		});
		const text = await readLimited(response, MAX_API_RESPONSE_BYTES);
		if (!response.ok) throw new Error(`Gemini file state failed: ${response.status}`);
		const state = JSON.parse(text).state;
		if (state === "ACTIVE") break;
		if (state === "FAILED") throw new Error("Gemini file processing failed");
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	if (Date.now() >= deadline) throw new Error("Gemini file processing timed out");
	return {
		uri: file.uri,
		cleanup: async () => {
			try {
				await fetch(metadataUrl, {
					method: "DELETE",
					headers: { "x-goog-api-key": key },
					signal: AbortSignal.timeout(10_000),
				});
			} catch {}
		},
	};
}

async function searchOpenAI(
	query: string,
	options: SearchOptions,
	resolved?: OpenAIAuth,
): Promise<{ answer: string; results: SearchResult[] }> {
	const auth = resolved ?? (await resolveOpenAI(options.context, options.signal));
	if (!auth) throw new Error("OpenAI web search is not configured");
	const headers = new Headers({
		...auth.headers,
		Authorization: `Bearer ${auth.key}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	});
	if (auth.codex) {
		const account = codexAccount(auth.key);
		if (account) headers.set("chatgpt-account-id", account);
		headers.set("originator", "pi");
	}
	const body = {
		model: auth.model,
		instructions: instructions(options),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [openAITool(options.domains)],
		include: ["web_search_call.action.sources"],
		tool_choice: "required",
		reasoning: { effort: OPENAI_SEARCH_REASONING_EFFORT },
		store: false,
		stream: true,
	};
	try {
		const response = await fetch(auth.codex ? CODEX_URL : OPENAI_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: combinedSignal(options.signal, 60_000),
		});
		const text = await readLimited(response, MAX_API_RESPONSE_BYTES);
		if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${redact(text, [auth.key]).slice(0, 500)}`);
		const parsed = parseOpenAI(text);
		const output = Array.isArray(parsed.output) ? parsed.output : [];
		const results = openAISources(output).slice(0, searchLimit(options.limit));
		const answer = boundedText(openAIAnswer(output), 40_000, 500).text;
		if (!answer && !results.length) throw new Error("OpenAI returned no answer or sources");
		return { answer, results };
	} catch (error) {
		const clean = redact(errorMessage(error), [auth.key]);
		if (clean === errorMessage(error)) throw error;
		throw new Error(clean);
	}
}

async function searchGeminiApi(
	query: string,
	options: SearchOptions,
	resolved?: GeminiAuth,
): Promise<{ answer: string; results: SearchResult[] }> {
	const config = searchConfig();
	const model = geminiModel(config);
	const prompt = `${instructions(options)}\n\nQuestion: ${query}`;
	const data = await geminiRequest<GeminiResponse>(
		`/v1beta/models/${encodeURIComponent(model)}:generateContent`,
		{
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			tools: [{ google_search: {} }],
		},
		{ signal: options.signal, context: options.context, auth: resolved },
	);
	return parseGeminiSearch(data, options.limit);
}

async function searchAntigravity(
	query: string,
	options: SearchOptions,
	auth: AntigravityAuth,
): Promise<{ answer: string; results: SearchResult[] }> {
	const config = searchConfig();
	const model = antigravityWireModel(secret(config.antigravitySearchModel) ?? ANTIGRAVITY_MODEL);
	const project = await ensureProjectContext({
		type: "oauth",
		refresh: "",
		access: auth.access,
		expires: Date.now() + 60_000,
	});
	const system = [ANTIGRAVITY_SEARCH_SYSTEM, instructions(options)].filter(Boolean).join(" ");
	const body = {
		project: project.effectiveProjectId,
		request: {
			contents: [{ role: "user", parts: [{ text: query }] }],
			systemInstruction: { role: "user", parts: [{ text: system }] },
			tools: [
				{
					googleSearch: {
						enhancedContent: {
							imageSearch: { maxResultCount: searchLimit(options.limit) },
						},
					},
				},
			],
			generationConfig: { candidateCount: 1 },
		},
		model,
		userAgent: "antigravity",
		requestType: "web_search",
	};
	try {
		const response = await fetchWithAgyCliTransport(
			`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.access}`,
					"Content-Type": "application/json",
					"User-Agent": buildAntigravityHarnessUserAgent(),
					"Accept-Encoding": "gzip",
				},
				body: JSON.stringify(body),
			},
			{ signal: combinedSignal(options.signal, 60_000) },
		);
		const text = await readLimited(response, MAX_API_RESPONSE_BYTES);
		if (!response.ok)
			throw new Error(`Antigravity search error ${response.status}: ${redact(text, [auth.access]).slice(0, 500)}`);
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			throw new Error("Antigravity search returned invalid JSON");
		}
		const payloadError = antigravityPayloadError(parsed);
		if (payloadError) throw new Error(`Antigravity search error: ${payloadError}`);
		return parseGeminiSearch(unwrapGeminiResponse(parsed), options.limit);
	} catch (error) {
		const clean = redact(errorMessage(error), [auth.access]);
		if (clean === errorMessage(error)) throw error;
		throw new Error(clean);
	}
}

function parseGeminiSearch(data: GeminiResponse, limit?: number): { answer: string; results: SearchResult[] } {
	const candidate = data.candidates?.[0];
	const rawAnswer = candidateText(candidate);
	const chunks: Array<{ web?: { uri?: string; title?: string } }> = candidate?.groundingMetadata?.groundingChunks ?? [];
	const seen = new Set<string>();
	const results: SearchResult[] = [];
	const chunkRanks = new Map<number, number>();
	for (const [index, chunk] of chunks.entries()) {
		const url = chunk.web?.uri?.trim();
		if (!url || seen.has(url)) continue;
		seen.add(url);
		results.push({ title: chunk.web?.title?.trim() || url, url, snippet: "" });
		chunkRanks.set(index, results.length);
		if (results.length >= searchLimit(limit)) break;
	}
	const supports = candidate?.groundingMetadata?.groundingSupports;
	const answer = boundedText(addGeminiCitations(rawAnswer, supports, chunkRanks), 40_000, 500).text;
	if (!answer && !results.length) throw new Error("Gemini returned no answer or sources");
	return { answer, results };
}

function unwrapGeminiResponse(value: unknown): GeminiResponse {
	const object = record(value);
	const nested = record(object?.response);
	return (nested ?? object ?? {}) as GeminiResponse;
}

function antigravityPayloadError(value: unknown): string | undefined {
	const object = record(value);
	const error = object?.error;
	if (typeof error === "string") return error;
	const details = record(error);
	if (typeof details?.message === "string") return details.message;
	if (details) return JSON.stringify(details).slice(0, 500);
	return undefined;
}

async function resolveOpenAI(context?: ExtensionContext, signal?: AbortSignal): Promise<OpenAIAuth | undefined> {
	if (context) {
		const piAuth = await resolvePiOpenAI(context);
		if (piAuth) return piAuth;
	}
	if (signal?.aborted) throw new Error("Aborted");
	const config = searchConfig();
	const key = secret(config.openaiApiKey) ?? secret(process.env.OPENAI_API_KEY);
	if (!key) return undefined;
	return { key, model: secret(config.openaiSearchModel) ?? OPENAI_SEARCH_MODEL, codex: false, headers: {} };
}

async function resolvePiOpenAI(context: ExtensionContext): Promise<OpenAIAuth | undefined> {
	for (const candidate of OPENAI_MODELS) {
		for (const id of candidate.ids) {
			try {
				const model = context.modelRegistry.find(candidate.provider, id);
				if (!model) continue;
				const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
				if (auth.ok && auth.apiKey)
					return {
						key: auth.apiKey,
						model: id,
						codex: candidate.provider === "openai-codex" || isCodexJwt(auth.apiKey),
						headers: auth.headers ?? {},
					};
			} catch {}
		}
	}
	return undefined;
}

async function resolvePiAntigravity(context?: ExtensionContext): Promise<AntigravityAuth | undefined> {
	if (!context) return undefined;
	if (!context.modelRegistry.getProviderAuthStatus(ANTIGRAVITY_PROVIDER).configured) return undefined;
	try {
		const access = await context.modelRegistry.getApiKeyForProvider(ANTIGRAVITY_PROVIDER);
		if (access) return { access };
	} catch {}
	for (const model of context.modelRegistry.getAll()) {
		if (model.provider !== ANTIGRAVITY_PROVIDER) continue;
		try {
			const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) return { access: auth.apiKey };
		} catch {}
	}
	return undefined;
}

async function resolveGeminiAuth(context?: ExtensionContext): Promise<GeminiAuth | undefined> {
	const config = searchConfig();
	const gatewayKey = cloudflareKey(config);
	if (gatewayKey) return { gatewayKey };
	const fromPi = await resolvePiGemini(context);
	if (fromPi) return fromPi;
	const key = secret(process.env.GEMINI_API_KEY) ?? secret(config.geminiApiKey);
	return key ? { key } : undefined;
}

async function resolvePiGemini(context?: ExtensionContext): Promise<GeminiAuth | undefined> {
	if (!context) return undefined;
	if (context.modelRegistry.getProviderAuthStatus(GOOGLE_PROVIDER).configured) {
		try {
			const key = await context.modelRegistry.getApiKeyForProvider(GOOGLE_PROVIDER);
			if (key) return { key };
		} catch {}
	}
	for (const model of context.modelRegistry.getAll()) {
		if (model.provider !== GOOGLE_PROVIDER) continue;
		try {
			const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) return { key: auth.apiKey, headers: auth.headers ?? {} };
		} catch {}
	}
	return undefined;
}

function instructions(options: SearchOptions): string {
	const lines = ["Search the web. Give a concise answer grounded in cited sources."];
	if (options.recency)
		lines.push(`Prefer sources from the past ${options.recency === "day" ? "24 hours" : options.recency}.`);
	const domains = normalizeDomains(options.domains);
	if (domains.allow.length) lines.push(`Use only these domains: ${domains.allow.join(", ")}.`);
	if (domains.deny.length) lines.push(`Do not use these domains: ${domains.deny.join(", ")}.`);
	lines.push(`Use at most ${searchLimit(options.limit)} sources.`);
	return lines.join(" ");
}

function openAITool(domains?: string[]): Record<string, unknown> {
	const normalized = normalizeDomains(domains);
	const filters = {
		...(normalized.allow.length ? { allowed_domains: normalized.allow } : {}),
		...(normalized.deny.length ? { blocked_domains: normalized.deny } : {}),
	};
	return Object.keys(filters).length ? { type: "web_search", filters } : { type: "web_search" };
}

function normalizeDomains(domains?: string[]): { allow: string[]; deny: string[] } {
	const allow: string[] = [];
	const deny: string[] = [];
	for (const raw of domains?.slice(0, 20) ?? []) {
		const excluded = raw.trim().startsWith("-");
		let value = raw.trim().replace(/^-/, "");
		try {
			value = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
		} catch {
			continue;
		}
		if (!/^[a-z0-9.-]+$/i.test(value)) continue;
		const target = excluded ? deny : allow;
		if (!target.includes(value)) target.push(value);
	}
	return { allow, deny };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseOpenAI(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) return { output: parsed };
		const object = record(parsed);
		if (object) return object;
	} catch {}
	const items: unknown[] = [];
	let completed: Record<string, unknown> | undefined;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const event = record(JSON.parse(payload));
			if (!event) continue;
			if (event.type === "response.output_item.done" && event.item) items.push(event.item);
			if ((event.type === "response.done" || event.type === "response.completed") && record(event.response))
				completed = record(event.response);
		} catch {}
	}
	if (completed)
		return Array.isArray(completed.output) && completed.output.length ? completed : { ...completed, output: items };
	if (items.length) return { output: items };
	throw new Error("OpenAI returned invalid JSON");
}

function openAIAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		const object = record(item);
		if (object?.type !== "message") continue;
		for (const value of Array.isArray(object.content) ? object.content : []) {
			const part = record(value);
			if (typeof part?.text !== "string") continue;
			parts.push(addOpenAICitations(part.text, part.annotations));
		}
	}
	return parts.join("\n").trim();
}

function addOpenAICitations(text: string, annotations: unknown): string {
	if (!Array.isArray(annotations)) return text;
	const insertions: Array<{ at: number; value: string }> = [];
	for (const item of annotations) {
		if (item?.type !== "url_citation" || typeof item.url !== "string" || typeof item.end_index !== "number") continue;
		insertions.push({
			at: item.end_index,
			value: ` [${typeof item.title === "string" ? item.title : "source"}](${cleanOpenAIUrl(item.url)})`,
		});
	}
	return applyInsertions(text, insertions);
}

function openAISources(output: unknown[]): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const add = (url: unknown, title: unknown, snippet = "") => {
		if (typeof url !== "string") return;
		const clean = cleanOpenAIUrl(url);
		if (!clean || seen.has(clean)) return;
		seen.add(clean);
		results.push({
			title: typeof title === "string" && title.trim() ? title.trim() : clean,
			url: clean,
			snippet: snippet.slice(0, 500),
		});
	};
	for (const item of output) {
		const object = record(item);
		if (!object) continue;
		if (object.type === "message") {
			for (const value of Array.isArray(object.content) ? object.content : []) {
				const part = record(value);
				for (const entry of Array.isArray(part?.annotations) ? part.annotations : []) {
					const annotation = record(entry);
					if (annotation?.type === "url_citation")
						add(annotation.url, annotation.title, snippet(part?.text, annotation.start_index, annotation.end_index));
				}
			}
		}
		if (object.type === "web_search_call") {
			const groups = [record(object.action)?.sources, object.sources, object.results];
			for (const group of groups) {
				for (const value of Array.isArray(group) ? group : []) {
					const source = record(value);
					add(source?.url ?? source?.source_website_url, source?.title ?? source?.caption);
				}
			}
		}
	}
	return results;
}

function addGeminiCitations(
	text: string,
	supports: Array<{ segment?: { endIndex?: number }; groundingChunkIndices?: number[] }> | undefined,
	ranks: Map<number, number>,
): string {
	if (!supports?.length) return text;
	const insertions = supports.flatMap((support) => {
		const end = support.segment?.endIndex;
		const refs = [
			...new Set(
				(support.groundingChunkIndices ?? [])
					.map((index) => ranks.get(index))
					.filter((rank): rank is number => Boolean(rank)),
			),
		];
		return typeof end === "number" && refs.length ? [{ at: end, value: refs.map((rank) => `[${rank}]`).join("") }] : [];
	});
	return applyInsertions(text, insertions);
}

function applyInsertions(text: string, insertions: Array<{ at: number; value: string }>): string {
	let value = text;
	for (const insertion of insertions.sort((a, b) => b.at - a.at))
		if (insertion.at >= 0 && insertion.at <= value.length)
			value = value.slice(0, insertion.at) + insertion.value + value.slice(insertion.at);
	return value;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
	return new TextDecoder().decode(await readBytes(response, maxBytes));
}

function searchConfig(): SearchConfig {
	return readWebConfig() as SearchConfig;
}
function antigravityWireModel(model: string): string {
	return resolveModelForHeaderStyle(model, "antigravity").actualModel;
}
function configProvider(): SearchProvider | undefined {
	const value = secret(searchConfig().provider)?.toLowerCase();
	if (value === "auto" || value === "openai" || value === "gemini" || value === "antigravity") return value;
	return undefined;
}
function configProviderOrder(): SearchBackend[] {
	const raw = searchConfig().providerOrder;
	if (!Array.isArray(raw)) return DEFAULT_PROVIDER_ORDER;
	const order: SearchBackend[] = [];
	for (const entry of raw) {
		const value = secret(entry)?.toLowerCase();
		if (!value || !SEARCH_BACKENDS.includes(value as SearchBackend)) continue;
		const backend = value as SearchBackend;
		if (!order.includes(backend)) order.push(backend);
	}
	return order.length ? order : DEFAULT_PROVIDER_ORDER;
}
function geminiBase(config: SearchConfig): string {
	return (secret(process.env.GOOGLE_GEMINI_BASE_URL) ?? secret(config.geminiBaseUrl) ?? GEMINI_HOST).replace(
		/\/+$/,
		"",
	);
}
function geminiModel(config: SearchConfig, override?: string): string {
	return override ?? secret(config.geminiSearchModel) ?? GEMINI_SEARCH_MODEL;
}
type GeminiCandidate = NonNullable<GeminiResponse["candidates"]>[number];
function candidateText(candidate: GeminiCandidate | undefined): string {
	return (
		candidate?.content?.parts
			?.map((part) => (typeof part.text === "string" ? part.text : ""))
			.filter(Boolean)
			.join("\n") ?? ""
	);
}

function searchLimit(value?: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value!))) : 5;
}

function snippet(text: unknown, start: unknown, end: unknown): string {
	if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number") return "";
	return text
		.slice(Math.max(0, start - 120), Math.min(text.length, end + 120))
		.replace(/\s+/g, " ")
		.slice(0, 500);
}

function cleanOpenAIUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return raw;
	}
}

function secret(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function cloudflareKey(config: SearchConfig): string | undefined {
	return geminiBase(config).includes("gateway.ai.cloudflare.com")
		? (secret(config.cloudflareApiKey) ?? secret(process.env.CLOUDFLARE_API_KEY))
		: undefined;
}
function redact(text: string, values: Array<string | undefined>): string {
	let clean = text;
	for (const value of values) if (value) clean = clean.split(value).join("[redacted]");
	return clean;
}
function aborted(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || errorMessage(error).toLowerCase().includes("abort");
}
function isCodexJwt(token: string): boolean {
	return Boolean(jwtPayload(token)?.["https://api.openai.com/auth"]);
}
function codexAccount(token: string): string | undefined {
	const auth = record(jwtPayload(token)?.["https://api.openai.com/auth"]);
	return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}
function jwtPayload(token: string): Record<string, unknown> | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}
