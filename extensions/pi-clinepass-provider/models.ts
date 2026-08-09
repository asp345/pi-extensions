/**
 * ClinePass / ClineFree model discovery and configuration.
 *
 * The model list comes from two public Cline endpoints:
 *
 * 1. `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` — the
 *    curated picker lists. The `free` array is the Cline Free tier and the
 *    `clinePass` array is the Cline Pass subscription tier. The `recommended`
 *    array (frontier BYOK models) is ignored here.
 * 2. `GET https://models.dev/api.json` — the public models.dev catalog. The
 *    `cline-pass` provider entry and other upstream entries supply context
 *    window, max output tokens, pricing, reasoning support and input
 *    modalities. models.dev is the source of truth for metadata; the
 *    recommended-models list only supplies which ids belong to each tier.
 *
 * The two tier lists are combined by the provider layer. Free model ids get a
 * `:free` suffix in the provider catalog.
 *
 * @module clinepass-models
 */

import { resolveApiBase } from "./env.js";
import { booleanValue, isRecord, numberValue, stringValue } from "./utils.js";

// ─── Thinking levels ───────────────────────────────────────────────────────

/** Pi thinking levels that map to provider-specific reasoning_effort. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Capability matrix mapping every pi thinking level to a provider-specific
 * `reasoning_effort` string or `null` (unsupported). Every model declares all
 * six levels — there are no implicit defaults.
 */
export type ThinkingLevelMap = Readonly<Record<ThinkingLevel, string | null>>;

/**
 * Uniform thinking level map for reasoning models. ClinePass/ClineFree accept
 * `reasoning_effort` in {none, low, medium, high, xhigh}; pi's `off` maps to
 * "none" and `minimal` is unsupported.
 */
export const DEFAULT_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

/** All-null map for models that do not reason. */
export const NO_THINKING_MAP: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
};

// ─── OpenAI-compat ─────────────────────────────────────────────────────────

/**
 * OpenAI-compat flags for Cline chat completions.
 *
 * Cline only accepts classic roles (`system`, `assistant`, `user`, `tool`,
 * `function`). pi-ai defaults to `developer` for reasoning models unless
 * `supportsDeveloperRole` is false (see pi-ai README).
 */
export interface ClinePassOpenAICompat {
	readonly supportsDeveloperRole: boolean;
	readonly thinkingFormat?: string;
}

export const CLINEPASS_OPENAI_COMPAT: ClinePassOpenAICompat = {
	supportsDeveloperRole: false,
};

// ─── Model config ──────────────────────────────────────────────────────────

/**
 * A Cline model registered with pi.
 *
 * `id` is the full Cline slug (e.g. "cline-pass/deepseek-v4-flash",
 * "deepseek/deepseek-v4-flash") — the value Cline's API expects in the
 * `model` field of `/api/v1/chat/completions`.
 *
 * `cost` is $/M tokens, used for usage tracking. Cline Free models are billed
 * at 0 by the free tier, so their cost is zeroed regardless of the upstream
 * model's models.dev pricing.
 */
/** A request-wide pricing tier: applies above an input-token threshold. */
export interface ModelCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly ["text"] | readonly ["text", "image"];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: ModelCostTier[] };
	contextWindow: number;
	maxTokens: number;
	/** Maps every pi thinking level to a provider-specific reasoning_effort. */
	thinkingLevelMap: ThinkingLevelMap;
	/** pi-ai openai-completions compat overrides. */
	compat: ClinePassOpenAICompat;
}

/** Which Cline tier a model belongs to — selects the pi provider name. */
export type ClineTier = "free" | "pass";

/** Result of resolving models: one list per Cline tier. */
export interface ResolvedModels {
	free: readonly ModelConfig[];
	pass: readonly ModelConfig[];
}

// ─── Endpoints ─────────────────────────────────────────────────────────────

/** Curated tier lists (free / clinePass), relative to the API base. */
export const RECOMMENDED_MODELS_ENDPOINT = "/api/v1/ai/cline/recommended-models";

/** Public models.dev catalog — absolute URL, not relative to the API base. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Timeout for discovery fetches (ms). Keeps registration responsive. */
export const MODELS_FETCH_TIMEOUT_MS = 5_000;

// ─── models.dev lookup ─────────────────────────────────────────────────────

/**
 * models.dev entry for a single model. Only the fields we consume are typed.
 */
interface ModelsDevEntry {
	name?: unknown;
	reasoning?: unknown;
	limit?: unknown;
	cost?: unknown;
	modalities?: unknown;
}

/** Parsed models.dev catalog: model id → entry (flattened across providers). */
type ModelsDevIndex = Map<string, ModelsDevEntry>;

/**
 * Some Cline tier ids are not in models.dev under their own id. Map them to a
 * models.dev entry that describes the same underlying model, used only for
 * metadata (name, limits, reasoning, modalities). Pricing still comes from the
 * tier: Cline Free is zeroed, Cline Pass uses the aliased entry's cost.
 */
const MODELS_DEV_ALIASES: Record<string, string> = {
	// Cline Free reuses the GLM-5.2 weights; cline-pass/glm-5.2 is in models.dev.
	"cline-free/glm-5.2": "cline-pass/glm-5.2",
	// Cline Pass exposes Qwen 3.8 Max; qwen/qwen3.8-max is the upstream entry.
	"cline-pass/qwen3.8-max": "qwen/qwen3.8-max",
};

/**
 * Build a flat id → entry index from the models.dev catalog. The catalog is a
 * top-level object keyed by provider id; each provider has a `models` object
 * keyed by model id.
 */
function indexModelsDev(catalog: unknown): ModelsDevIndex {
	const index: ModelsDevIndex = new Map();
	if (!isRecord(catalog)) return index;
	for (const provider of Object.values(catalog)) {
		if (!isRecord(provider)) continue;
		const models = provider.models;
		if (!isRecord(models)) continue;
		for (const [id, entry] of Object.entries(models)) {
			if (isRecord(entry)) index.set(id, entry as ModelsDevEntry);
		}
	}
	return index;
}

/**
 * Resolve a Cline tier id to its models.dev entry, applying the catalog alias
 * when the tier id is absent from models.dev.
 */
function lookupModelsDev(index: ModelsDevIndex, id: string): ModelsDevEntry | undefined {
	return index.get(id) ?? index.get(MODELS_DEV_ALIASES[id] ?? id);
}

// ─── Parsing ───────────────────────────────────────────────────────────────

/** Read a number field, falling back to a default. */
function numOr(value: unknown, fallback: number): number {
	return numberValue(value) ?? fallback;
}

/**
 * Coerce models.dev input modalities into pi's `("text" | "image")[]` shape.
 * Image-capable models get `["text", "image"]`; everything else is text-only.
 */
function parseInput(modalities: unknown): readonly ["text"] | readonly ["text", "image"] {
	const input = isRecord(modalities) && Array.isArray(modalities.input) ? modalities.input : [];
	return input.some((m) => m === "image") ? ["text", "image"] : ["text"];
}

/**
 * Parse a models.dev cost object into pi's $/M-token cost shape.
 * models.dev already reports $/M tokens, so no unit conversion is needed.
 * `tiers` (request-wide pricing tiers) are preserved when present.
 */
function parseCost(cost: unknown, zero: boolean): ModelConfig["cost"] {
	const c = isRecord(cost) ? cost : {};
	const base = {
		input: zero ? 0 : numOr(c.input, 0),
		output: zero ? 0 : numOr(c.output, 0),
		cacheRead: zero ? 0 : numOr(c.cache_read, 0),
		cacheWrite: zero ? 0 : numOr(c.cache_write, 0),
	};
	if (zero) return base;
	const tiersRaw = Array.isArray(c.tiers) ? c.tiers : [];
	const tiers = tiersRaw
		.map((t): ModelCostTier | undefined => {
			if (!isRecord(t) || !isRecord(t.tier)) return undefined;
			const inputTokensAbove = numberValue(t.tier.size);
			if (inputTokensAbove == null) return undefined;
			return {
				inputTokensAbove,
				input: numOr(t.input, 0),
				output: numOr(t.output, 0),
				cacheRead: numOr(t.cache_read, 0),
				cacheWrite: numOr(t.cache_write, 0),
			};
		})
		.filter((t): t is ModelCostTier => t != null);
	return tiers.length > 0 ? { ...base, tiers } : base;
}

/**
 * Build a `ModelConfig` from a Cline tier id plus its models.dev metadata.
 * Fields absent from models.dev fall back to conservative defaults.
 */
function parseModel(id: string, tier: ClineTier, entry: ModelsDevEntry | undefined): ModelConfig {
	const reasoning = booleanValue(entry?.reasoning) ?? true;
	const limit = isRecord(entry?.limit) ? entry?.limit : undefined;
	const cost = parseCost(entry?.cost, tier === "free");
	return {
		id,
		name: stringValue(entry?.name) ?? id,
		reasoning,
		input: parseInput(entry?.modalities),
		cost,
		contextWindow: numOr(limit?.context, 128_000),
		maxTokens: numOr(limit?.output, 8_192),
		thinkingLevelMap: reasoning ? DEFAULT_THINKING_LEVEL_MAP : NO_THINKING_MAP,
		compat: CLINEPASS_OPENAI_COMPAT,
	};
}

// ─── Remote discovery ──────────────────────────────────────────────────────

/** Raw entry from the recommended-models endpoint. */
interface RawRecommendedEntry {
	id?: unknown;
}

/** Raw shape of the recommended-models endpoint response. */
interface RawRecommendedResponse {
	free?: unknown;
	clinePass?: unknown;
	recommended?: unknown;
}

/** I/O options for discovery, injectable for testability. */
export interface RemoteModelsOptions {
	apiBase?: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

/** Fetch JSON with an AbortController timeout. Returns undefined on any error. */
async function fetchJson(url: string, fetchFn: typeof globalThis.fetch, timeoutMs: number): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchFn(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Extract a string id list from a raw recommended-models array field. */
function idsFromField(field: unknown): string[] {
	if (!Array.isArray(field)) return [];
	return field
		.map((entry): string | undefined => stringValue(isRecord(entry) ? entry.id : undefined))
		.filter((id): id is string => id != null && id.length > 0);
}

/**
 * Discover Cline Free and Cline Pass models from the two public endpoints.
 *
 * Returns `{free, pass}` on success, or `undefined` when either endpoint is
 * unavailable or no tier ids are recovered.
 */
export async function fetchRemoteModels(options: RemoteModelsOptions = {}): Promise<ResolvedModels | undefined> {
	const apiBase = options.apiBase ?? resolveApiBase();
	const fetchFn = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? MODELS_FETCH_TIMEOUT_MS;
	if (!fetchFn) return undefined;

	const [recommendedRaw, catalogRaw] = await Promise.all([
		fetchJson(`${apiBase}${RECOMMENDED_MODELS_ENDPOINT}`, fetchFn, timeoutMs),
		fetchJson(MODELS_DEV_URL, fetchFn, timeoutMs),
	]);

	if (recommendedRaw === undefined || catalogRaw === undefined) return undefined;

	const recommended = isRecord(recommendedRaw) ? (recommendedRaw as RawRecommendedResponse) : undefined;
	const freeIds = idsFromField(recommended?.free);
	const passIds = idsFromField(recommended?.clinePass);
	if (freeIds.length === 0 && passIds.length === 0) return undefined;

	const index = indexModelsDev(catalogRaw);
	const free = freeIds.map((id) => parseModel(id, "free", lookupModelsDev(index, id)));
	const pass = passIds.map((id) => parseModel(id, "pass", lookupModelsDev(index, id)));
	return { free, pass };
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolve both Cline tier lists from the public catalog endpoints.
 * Returns undefined when discovery fails so the extension can skip registration
 * without aborting pi startup.
 */
export async function resolveModels(options: RemoteModelsOptions = {}): Promise<ResolvedModels | undefined> {
	return fetchRemoteModels(options);
}
