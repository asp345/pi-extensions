/**
 * Model catalog resolved from v1internal:fetchAvailableModels, refreshed at
 * runtime so new releases appear without code changes. The service lists
 * tiers as separate ids (gemini-3.7-flash-low/-medium/-high) each with its
 * own thinkingBudget; this module collapses them into base models with a
 * tiers list. Falls back to a static snapshot when the network is down.
 */

import { ANTIGRAVITY_ENDPOINT_FALLBACKS } from "./constants.ts";
import { buildAntigravityHarnessUserAgent } from "./fingerprint.ts";
import { fetchWithAgyCliTransport } from "./transport.ts";

interface AgyModelTier {
	tier: "default" | "low" | "medium" | "high";
	wireModel: string;
	thinkingBudget: number;
}

export interface AgyModelDefinition {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: Array<"text" | "image">;
	tiers?: AgyModelTier[];
}

interface RemoteModelInfo {
	displayName?: string;
	supportsThinking?: boolean;
	supportsImages?: boolean;
	thinkingBudget?: number;
	maxTokens?: number;
	maxOutputTokens?: number;
}

interface FetchAvailableModelsResponse {
	models?: Record<string, RemoteModelInfo>;
}

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const TIER_SUFFIX_REGEX = /-(minimal|low|medium|high|extra-low|tiered)$/;

let cachedModels: AgyModelDefinition[] | undefined;

const isTier = (suffix: string): suffix is "low" | "medium" | "high" =>
	suffix === "low" || suffix === "medium" || suffix === "high";

function isAgentModel(id: string): boolean {
	const lower = id.toLowerCase();
	if (lower.startsWith("chat_") || lower.startsWith("tab_")) return false;
	if (lower.startsWith("gemini-2.")) return false;
	return lower.startsWith("gemini-") || lower.startsWith("claude-") || lower.startsWith("gpt-oss-");
}

/**
 * Collapse tiered model ids into base models with a tiers list.
 * gemini-3.7-flash-{low,medium,high} → gemini-3.7-flash with three tiers.
 */
function normalizeRemoteModels(payload: FetchAvailableModelsResponse): AgyModelDefinition[] {
	const byBase = new Map<
		string,
		{
			def: AgyModelDefinition;
			tiers: Map<string, { wireModel: string; thinkingBudget: number }>;
		}
	>();
	for (const [id, info] of Object.entries(payload.models ?? {})) {
		if (!isAgentModel(id)) continue;
		const match = TIER_SUFFIX_REGEX.exec(id);
		const suffix = match?.[1];
		const base = match ? id.slice(0, -match[0].length) : id;
		let entry = byBase.get(base);
		if (!entry) {
			entry = {
				def: {
					id: base,
					// Strip the trailing tier parenthetical: "Gemini 3.7 Flash (Medium)" → "Gemini 3.7 Flash"
					name: (info.displayName ?? base).replace(/\s*\((?:[^()]*)\)\s*$/u, ""),
					reasoning: info.supportsThinking ?? true,
					contextWindow: info.maxTokens ?? 1_048_576,
					maxTokens: info.maxOutputTokens ?? 65_536,
					input: info.supportsImages ? ["text", "image"] : ["text"],
				},
				tiers: new Map(),
			};
			byBase.set(base, entry);
		} else {
			entry.def.contextWindow = Math.max(entry.def.contextWindow, info.maxTokens ?? 0);
			entry.def.maxTokens = Math.max(entry.def.maxTokens, info.maxOutputTokens ?? 0);
		}
		if (suffix && isTier(suffix)) {
			entry.tiers.set(suffix, { wireModel: id, thinkingBudget: info.thinkingBudget ?? 4000 });
		} else if (!suffix) {
			// Untiered reasoning models carry their budget directly.
			entry.tiers.set("default", { wireModel: id, thinkingBudget: info.thinkingBudget ?? 1024 });
		}
	}
	const order: Record<AgyModelTier["tier"], number> = { default: 0, low: 1, medium: 2, high: 3 };
	return [...byBase.values()].map(({ def, tiers }) => {
		const tierList = [...tiers.entries()]
			.filter(([tier]) => tier !== "default" || tiers.size === 1)
			.map(([tier, value]) => ({ tier: tier as AgyModelTier["tier"], ...value }))
			.sort((a, b) => order[a.tier] - order[b.tier]);
		return { ...def, ...(tierList.length ? { tiers: tierList } : {}) };
	});
}

/** Live catalog for the model resolver; undefined until the first refresh succeeds. */
export function getLiveModelCatalog(): AgyModelDefinition[] | undefined {
	return cachedModels;
}

async function fetchModelsFromNetwork(accessToken: string, signal?: AbortSignal): Promise<AgyModelDefinition[]> {
	let lastError: unknown;
	for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
		try {
			const response = await fetchWithAgyCliTransport(
				`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
						"User-Agent": buildAntigravityHarnessUserAgent(),
					},
					body: "{}",
				},
				{ signal, timeoutMs: 15_000, idleTimeoutMs: 15_000 },
			);
			if (response.ok) {
				const models = normalizeRemoteModels((await response.json()) as FetchAvailableModelsResponse);
				if (models.length > 0) return models;
				lastError = new Error(`no usable models at ${endpoint}`);
			} else {
				lastError = new Error(`HTTP ${response.status} at ${endpoint}`);
			}
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Refresh the model catalog from the network. Throws on failure; the caller
 * keeps the previous catalog in that case.
 */
export async function refreshModelCatalog(accessToken: string, signal?: AbortSignal): Promise<AgyModelDefinition[]> {
	const models = await fetchModelsFromNetwork(accessToken, signal);
	cachedModels = models;
	return models;
}

/** Static snapshot used before the first successful network refresh. */
export const STATIC_MODEL_CATALOG: AgyModelDefinition[] = [
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.8-flash-low", thinkingBudget: 1000 },
			{ tier: "medium", wireModel: "gemini-3.8-flash-medium", thinkingBudget: 4000 },
			{ tier: "high", wireModel: "gemini-3.8-flash-high", thinkingBudget: -1 },
		],
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.7-flash-low", thinkingBudget: 1000 },
			{ tier: "medium", wireModel: "gemini-3.7-flash-medium", thinkingBudget: 4000 },
			{ tier: "high", wireModel: "gemini-3.7-flash-high", thinkingBudget: -1 },
		],
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.6-flash-low", thinkingBudget: 1000 },
			{ tier: "medium", wireModel: "gemini-3.6-flash-medium", thinkingBudget: 4000 },
			{ tier: "high", wireModel: "gemini-3.6-flash-high", thinkingBudget: -1 },
		],
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		input: ["text", "image"],
	},
	{
		id: "claude-sonnet-4-6-thinking",
		name: "Claude Sonnet 4.6 Thinking",
		reasoning: true,
		contextWindow: 250_000,
		maxTokens: 64_000,
		input: ["text", "image"],
	},
	{
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking",
		reasoning: true,
		contextWindow: 250_000,
		maxTokens: 64_000,
		input: ["text", "image"],
	},
	{
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B Medium",
		reasoning: true,
		contextWindow: 131_072,
		maxTokens: 32_768,
		input: ["text", "image"],
	},
];
