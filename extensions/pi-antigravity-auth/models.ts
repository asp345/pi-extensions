import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_USER_AGENT } from "./constants.ts";
import { fetchWithAgyCliTransport } from "./transport.ts";

type AgyThinkingLevel = "LOW" | "MEDIUM" | "HIGH";

export interface AgyTierSpec {
	wireModel: string;
	modelEnum?: string;
	thinkingBudget?: number;
	thinkingLevel?: AgyThinkingLevel;
}

interface AgyModelTier extends AgyTierSpec {
	tier: "low" | "medium" | "high";
}

export interface AgyModelDefinition {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: Array<"text" | "image">;
	tiers: AgyModelTier[];
}

interface RemoteModelInfo {
	displayName?: string;
	model?: string;
	supportsThinking?: boolean;
	supportsImages?: boolean;
	thinkingBudget?: number;
	thinkingLevel?: number;
	maxTokens?: number;
	maxOutputTokens?: number;
}

interface FetchAvailableModelsResponse {
	models?: Record<string, RemoteModelInfo>;
	agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
	deprecatedModelIds?: Record<string, { newModelId?: string }>;
}

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const TIER_SUFFIX_REGEX = /-(low|medium|high)$/;
const TIER_ORDER: Record<AgyModelTier["tier"], number> = { low: 0, medium: 1, high: 2 };
const THINKING_LEVELS: Record<number, AgyThinkingLevel> = { 1: "LOW", 2: "MEDIUM", 3: "HIGH" };

function remoteTier(wireModel: string, tier: AgyModelTier["tier"], info: RemoteModelInfo): AgyModelTier {
	const thinkingLevel = info.thinkingLevel === undefined ? undefined : THINKING_LEVELS[info.thinkingLevel];
	return {
		tier,
		wireModel,
		...(info.model ? { modelEnum: info.model } : {}),
		...(thinkingLevel
			? { thinkingBudget: info.thinkingBudget ?? 0, thinkingLevel }
			: info.thinkingBudget === undefined
				? {}
				: { thinkingBudget: info.thinkingBudget }),
	};
}

function normalizeRemoteModels(payload: FetchAvailableModelsResponse): AgyModelDefinition[] {
	const models = payload.models ?? {};
	const publicIds = new Map<string, string>();
	for (const [oldId, replacement] of Object.entries(payload.deprecatedModelIds ?? {})) {
		if (replacement.newModelId) publicIds.set(replacement.newModelId, oldId);
	}
	const agentIds = (payload.agentModelSorts ?? [])
		.flatMap((sort) => sort.groups ?? [])
		.flatMap((group) => group.modelIds ?? []);
	const byBase = new Map<string, AgyModelDefinition>();
	for (const wireModel of new Set(agentIds)) {
		const info = models[wireModel];
		if (!info) continue;
		const publicId = publicIds.get(wireModel) ?? wireModel;
		const match = TIER_SUFFIX_REGEX.exec(publicId);
		const base = match ? publicId.slice(0, -match[0].length) : publicId;
		let model = byBase.get(base);
		if (!model) {
			model = {
				id: base,
				name: (info.displayName ?? base).replace(/\s*\((?:[^()]*)\)\s*$/u, ""),
				reasoning: info.supportsThinking ?? true,
				contextWindow: info.maxTokens ?? 1_048_576,
				maxTokens: info.maxOutputTokens ?? 65_536,
				input: info.supportsImages ? ["text", "image"] : ["text"],
				tiers: [],
			};
			byBase.set(base, model);
		} else {
			model.contextWindow = Math.max(model.contextWindow, info.maxTokens ?? 0);
			model.maxTokens = Math.max(model.maxTokens, info.maxOutputTokens ?? 0);
		}
		model.tiers.push(remoteTier(wireModel, (match?.[1] as AgyModelTier["tier"] | undefined) ?? "medium", info));
	}
	for (const model of byBase.values()) model.tiers.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
	return [...byBase.values()];
}

export async function refreshModelCatalog(
	accessToken: string,
	project: string,
	signal?: AbortSignal,
): Promise<AgyModelDefinition[]> {
	const response = await fetchWithAgyCliTransport(
		`${ANTIGRAVITY_ENDPOINT}${FETCH_AVAILABLE_MODELS_PATH}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": ANTIGRAVITY_USER_AGENT,
			},
			body: JSON.stringify({ project }),
		},
		{ signal, timeoutMs: 15_000, idleTimeoutMs: 15_000 },
	);
	if (!response.ok) throw new Error(`fetchAvailableModels failed: HTTP ${response.status}`);
	const models = normalizeRemoteModels((await response.json()) as FetchAvailableModelsResponse);
	if (models.length === 0) throw new Error("fetchAvailableModels returned no usable models");
	return models;
}

export const STATIC_MODEL_CATALOG: AgyModelDefinition[] = [
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.8-flash-low", modelEnum: "MODEL_PLACEHOLDER_M320", thinkingBudget: 1000 },
			{
				tier: "medium",
				wireModel: "gemini-3.8-flash-medium",
				modelEnum: "MODEL_PLACEHOLDER_M319",
				thinkingBudget: 4000,
			},
			{ tier: "high", wireModel: "gemini-3.8-flash-high", modelEnum: "MODEL_PLACEHOLDER_M318", thinkingBudget: -1 },
		],
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.7-flash-low", modelEnum: "MODEL_PLACEHOLDER_M300", thinkingBudget: 1000 },
			{
				tier: "medium",
				wireModel: "gemini-3.7-flash-medium",
				modelEnum: "MODEL_PLACEHOLDER_M299",
				thinkingBudget: 4000,
			},
			{ tier: "high", wireModel: "gemini-3.7-flash-high", modelEnum: "MODEL_PLACEHOLDER_M298", thinkingBudget: -1 },
		],
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.6-flash-low", modelEnum: "MODEL_PLACEHOLDER_M73", thinkingBudget: 1000 },
			{
				tier: "medium",
				wireModel: "gemini-3.6-flash-medium",
				modelEnum: "MODEL_PLACEHOLDER_M72",
				thinkingBudget: 4000,
			},
			{ tier: "high", wireModel: "gemini-3.6-flash-high", modelEnum: "MODEL_PLACEHOLDER_M71", thinkingBudget: -1 },
		],
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65535,
		input: ["text", "image"],
		tiers: [
			{ tier: "low", wireModel: "gemini-3.1-pro-low", modelEnum: "MODEL_PLACEHOLDER_M36", thinkingBudget: 1001 },
			{ tier: "high", wireModel: "gemini-pro-agent", modelEnum: "MODEL_PLACEHOLDER_M16", thinkingBudget: 10001 },
		],
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 128000,
		input: ["text", "image"],
		tiers: [
			{
				tier: "low",
				wireModel: "claude-opus-5-5-low",
				modelEnum: "MODEL_PLACEHOLDER_M400",
				thinkingBudget: 0,
				thinkingLevel: "LOW",
			},
			{
				tier: "medium",
				wireModel: "claude-opus-5-5-medium",
				modelEnum: "MODEL_PLACEHOLDER_M401",
				thinkingBudget: 0,
				thinkingLevel: "MEDIUM",
			},
			{
				tier: "high",
				wireModel: "claude-opus-5-5-high",
				modelEnum: "MODEL_PLACEHOLDER_M402",
				thinkingBudget: 0,
				thinkingLevel: "HIGH",
			},
		],
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 128000,
		input: ["text", "image"],
		tiers: [
			{
				tier: "low",
				wireModel: "claude-sonnet-5-5-low",
				modelEnum: "MODEL_PLACEHOLDER_M403",
				thinkingBudget: 0,
				thinkingLevel: "LOW",
			},
			{
				tier: "medium",
				wireModel: "claude-sonnet-5-5-medium",
				modelEnum: "MODEL_PLACEHOLDER_M404",
				thinkingBudget: 0,
				thinkingLevel: "MEDIUM",
			},
			{
				tier: "high",
				wireModel: "claude-sonnet-5-5-high",
				modelEnum: "MODEL_PLACEHOLDER_M405",
				thinkingBudget: 0,
				thinkingLevel: "HIGH",
			},
		],
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		reasoning: true,
		contextWindow: 131072,
		maxTokens: 32768,
		input: ["text"],
		tiers: [
			{
				tier: "medium",
				wireModel: "gpt-oss-120b-medium",
				modelEnum: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
				thinkingBudget: 8192,
			},
		],
	},
];
