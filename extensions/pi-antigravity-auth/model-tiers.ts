import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { AgyModelDefinition } from "./agy/index.ts";
import { resolveModelForAntigravity } from "./agy/index.ts";

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

export function modelThinkingLevelMap(model: AgyModelDefinition): ThinkingLevelMap | undefined {
	if (!model.reasoning) return undefined;
	const tiers = new Set(model.tiers?.map(({ tier }) => tier));
	if (tiers.size === 0 || tiers.has("default")) return { ...TIER_THINKING_LEVEL_MAP };
	return {
		minimal: null,
		low: tiers.has("low") ? "low" : null,
		medium: tiers.has("medium") ? "medium" : null,
		high: tiers.has("high") ? "high" : null,
		xhigh: null,
		max: null,
	};
}
