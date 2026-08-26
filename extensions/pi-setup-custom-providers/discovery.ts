import type { AuthResult, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { CustomModelConfig, CustomProviderConfig, ModelCost, ModelMetadata } from "./types.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./types.ts";

const MAX_CATALOG_BYTES = 16_000_000;

const REQUEST_TIMEOUT_MS = 15_000;

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Prices may legitimately be zero; negatives are provider sentinels for variable pricing. */
function rate(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Providers spell their capability list differently: `features` (Novita),
 * `supported_features` (Baseten), `supported_parameters` (OpenRouter), plus
 * `tags` and `capabilities` elsewhere. All of them are read so a declared
 * capability is never missed because of the field name.
 */
export function capabilityTokens(raw: Record<string, unknown>): Set<string> {
	const tokens = new Set<string>();
	for (const field of [raw.features, raw.supported_features, raw.tags, raw.capabilities, raw.supported_parameters]) {
		for (const value of stringArray(field)) tokens.add(value.trim().toLowerCase().replaceAll("-", "_"));
	}
	return tokens;
}

function reasoningMetadata(raw: Record<string, unknown>): Pick<ModelMetadata, "reasoning" | "thinkingLevelMap"> {
	const reasoning = record(raw.reasoning);
	const tokens = capabilityTokens(raw);
	const enabled =
		raw.reasoning === true ||
		reasoning !== undefined ||
		raw.custom_reasoning === true ||
		raw.reasoning_effort === true ||
		tokens.has("reasoning") ||
		tokens.has("thinking") ||
		tokens.has("reasoning_effort") ||
		tokens.has("custom_reasoning");
	if (!enabled) return {};

	const supported = new Set(stringArray(reasoning?.supported_efforts));
	if (supported.size === 0) return { reasoning: true };
	const thinkingLevelMap: ThinkingLevelMap = {};
	if (reasoning?.mandatory === true) thinkingLevelMap.off = null;
	for (const level of EFFORT_LEVELS) thinkingLevelMap[level] = supported.has(level) ? level : null;
	return { reasoning: true, thinkingLevelMap };
}

/** Auto-detected USD-per-million-token prices must stay within this range. */
const PRICE_MIN = 0.001;
const PRICE_MAX = 100;

/** Raw listing value multipliers: per-token, per-million, and Novita units. */
const PRICE_MULTIPLIERS = [1_000_000, 1, 1 / 10_000] as const;

type PriceMultiplier = number | "auto";

function normalizePrice(raw: number, multiplier: PriceMultiplier): number | undefined {
	if (raw === 0) return 0;
	if (typeof multiplier === "number") return raw * multiplier;
	for (const candidate of PRICE_MULTIPLIERS) {
		const normalized = raw * candidate;
		if (normalized >= PRICE_MIN && normalized <= PRICE_MAX) return normalized;
	}
	return undefined;
}

function pricePerMillion(value: unknown, multiplier: PriceMultiplier): number | undefined {
	const object = record(value);
	const raw = object ? rate(object.price_per_m) : rate(value);
	return raw === undefined ? undefined : normalizePrice(raw, multiplier);
}

function pricing(raw: Record<string, unknown>, multiplier: PriceMultiplier): ModelCost | undefined {
	const value = record(raw.pricing);
	if (!value) return undefined;
	const input = pricePerMillion(value.prompt, multiplier);
	const output = pricePerMillion(value.completion, multiplier);
	if (input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		cacheRead: pricePerMillion(value.input_cache_read ?? value.cache_prompt, multiplier) ?? 0,
		cacheWrite: pricePerMillion(value.input_cache_write ?? value.cache_write, multiplier) ?? 0,
	};
}

export function parseModelMetadata(value: unknown, multiplier: PriceMultiplier = "auto"): ModelMetadata | undefined {
	const raw = record(value);
	if (!raw) return undefined;
	const id = string(raw.id) ?? string(raw.name);
	if (!id) return undefined;
	const architecture = record(raw.architecture);
	const capabilities = record(raw.capabilities);
	const modalities = [
		...stringArray(raw.input_modalities),
		...stringArray(raw.modalities),
		...stringArray(raw.inputTypes),
		...stringArray(raw.input_types),
		...stringArray(architecture?.input_modalities),
		...stringArray(capabilities?.input),
	].map((item) => item.toLowerCase());
	const tokens = capabilityTokens(raw);
	const image =
		modalities.some((item) => item.includes("image") || item.includes("vision")) ||
		tokens.has("image") ||
		tokens.has("vision") ||
		raw.supports_image === true ||
		raw.supports_vision === true ||
		capabilities?.image === true ||
		capabilities?.vision === true;
	const contextWindow =
		number(raw.context_window) ??
		number(raw.contextWindow) ??
		number(raw.context_length) ??
		number(raw.context_size) ??
		number(raw.max_context_window) ??
		number(raw.max_input_tokens) ??
		number(capabilities?.context_window);
	const topProvider = record(raw.top_provider);
	const maxTokens =
		number(raw.max_output_tokens) ??
		number(raw.maxOutputTokens) ??
		number(raw.max_completion_tokens) ??
		number(topProvider?.max_completion_tokens) ??
		number(raw.max_tokens) ??
		number(raw.maxTokens) ??
		number(capabilities?.max_output_tokens);
	return {
		id,
		name: string(raw.name) ?? id,
		...reasoningMetadata(raw),
		input: image ? ["text", "image"] : ["text"],
		cost: pricing(raw, multiplier),
		contextWindow,
		maxTokens,
		contextDetected: contextWindow !== undefined,
		maxTokensDetected: maxTokens !== undefined,
	};
}

export function modelEndpointCandidates(config: CustomProviderConfig): string[] {
	const baseUrl = config.baseUrl?.replace(/\/+$/u, "");
	if (!baseUrl || config.api === "anthropic-messages") return [];
	if (config.api === "google-generative-ai") {
		return [baseUrl.endsWith("/v1beta") ? `${baseUrl}/models` : `${baseUrl}/v1beta/models`];
	}
	return baseUrl.match(/\/v\d+(?:beta)?$/u) ? [`${baseUrl}/models`] : [`${baseUrl}/v1/models`, `${baseUrl}/models`];
}

async function readJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new Error("model catalog is too large");
	const text = await response.text();
	if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error("model catalog is too large");
	return JSON.parse(text) as unknown;
}

function requestHeaders(config: CustomProviderConfig, auth?: AuthResult): Record<string, string> {
	const headers = Object.fromEntries(
		Object.entries({ ...config.headers, ...auth?.auth.headers }).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	if (auth?.auth.apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
		headers.Authorization = `Bearer ${auth.auth.apiKey}`;
	}
	return headers;
}

export async function discoverProviderModels(
	config: CustomProviderConfig,
	auth?: AuthResult,
	signal?: AbortSignal,
): Promise<Map<string, ModelMetadata>> {
	const endpoints = modelEndpointCandidates(config);
	if (endpoints.length === 0) throw new Error("this provider has no supported model-list endpoint");
	const errors: string[] = [];
	for (const endpoint of endpoints) {
		try {
			const response = await fetch(endpoint, { headers: requestHeaders(config, auth), signal: withTimeout(signal) });
			if (!response.ok) {
				errors.push(`${response.status} ${response.statusText} at ${endpoint}`);
				continue;
			}
			const payload = record(await readJson(response));
			const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
			const models = new Map<string, ModelMetadata>();
			for (const item of items) {
				const model = parseModelMetadata(item, config.priceMultiplier);
				if (model) models.set(model.id.trim().toLowerCase(), model);
			}
			if (models.size > 0) return models;
			errors.push(`empty model catalog at ${endpoint}`);
		} catch (error) {
			if (signal?.aborted) throw error;
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(errors.join("; "));
}

/**
 * Capabilities, effort names, and prices all describe the serving endpoint, so
 * every field is taken from the provider's own listing or from the value set by
 * hand. A shared catalog describes some other gateway and would claim support
 * this endpoint may not have.
 */
export function mergeConfiguredModels(
	configured: readonly CustomModelConfig[],
	discovered: ReadonlyMap<string, ModelMetadata>,
): CustomModelConfig[] {
	return configured.map((model) => {
		const key = model.id.trim().toLowerCase();
		const metadata = discovered.get(key);
		if (!metadata) return { ...model };
		const manualLimits = model.limitSource === "manual";
		return {
			...model,
			name: model.name ?? metadata.name ?? model.id,
			reasoning: metadata.reasoning === true ? true : model.reasoning,
			thinkingLevelMap:
				model.thinkingLevelMap ?? (metadata.thinkingLevelMap ? { ...metadata.thinkingLevelMap } : undefined),
			input: metadata.input?.includes("image") ? ["text", "image"] : (model.input ?? ["text"]),
			cost: metadata.cost ?? model.cost,
			contextWindow: manualLimits
				? (model.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
				: (metadata.contextWindow ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
			maxTokens: manualLimits
				? (model.maxTokens ?? DEFAULT_MAX_TOKENS)
				: (metadata.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS),
			limitSource: manualLimits ? "manual" : metadata.contextWindow || metadata.maxTokens ? "detected" : "default",
		};
	});
}
