import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { AgyModelDefinition, AgyTierSpec } from "./models.ts";

const TIERS = ["low", "medium", "high"] as const;

export function modelThinkingLevelMap(model: AgyModelDefinition): ThinkingLevelMap {
	const map: ThinkingLevelMap = { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
	for (const { tier, ...spec } of model.tiers) map[tier] = JSON.stringify(spec);
	return map;
}

export function resolveModel(model: Model<Api>, reasoning?: ThinkingLevel): AgyTierSpec {
	const map = model.thinkingLevelMap ?? {};
	const requested = reasoning === "low" || reasoning === "medium" || reasoning === "high" ? reasoning : "medium";
	const spec = [requested, ...TIERS].map((tier) => map[tier]).find((value) => typeof value === "string");
	return spec ? (JSON.parse(spec) as AgyTierSpec) : { wireModel: model.id };
}
