/**
 * Model resolution: base id + thinking tier → wire model id + thinking budget.
 * The service defines tiers as separate model ids (gemini-3.7-flash-low /
 * -medium / -high, each with its own thinkingBudget), so tier selection is
 * expressed through the wire model id. Budgets come from the live catalog
 * when available and from STATIC_MODEL_CATALOG before the first refresh.
 */
import { getLiveModelCatalog, STATIC_MODEL_CATALOG } from "./models.ts";

interface ResolvedModel {
	actualModel: string;
	thinkingBudget?: number;
}

function findTier(baseId: string, tier: string | undefined): ResolvedModel | undefined {
	const entry = (getLiveModelCatalog() ?? STATIC_MODEL_CATALOG).find((model) => model.id === baseId);
	const found = entry?.tiers?.find((candidate) => candidate.tier === (tier ?? "medium"));
	return found ? { actualModel: found.wireModel, thinkingBudget: found.thinkingBudget } : undefined;
}

export function resolveModelForAntigravity(requestedModel: string, tier?: string): ResolvedModel {
	const id = requestedModel.toLowerCase();
	if (/image|imagen/i.test(id)) return { actualModel: requestedModel };

	if (/^gemini-3\.1-pro/.test(id)) {
		return findTier("gemini-3.1-pro", tier) ?? { actualModel: "gemini-3.1-pro-low", thinkingBudget: 1001 };
	}
	const flash = /^gemini-3\.[678]-flash/.exec(id);
	if (flash) {
		return findTier(flash[0], tier) ?? { actualModel: requestedModel };
	}
	if (/^gemini-3(?:\.5)?-flash/.test(id)) {
		return { actualModel: "gemini-3-flash-agent", thinkingBudget: 4000 };
	}
	if (/^gpt-oss-120b/.test(id)) {
		return { actualModel: "gpt-oss-120b-medium", thinkingBudget: 8192 };
	}
	if (id.includes("claude")) {
		// agy CLI sends a compact 1024-token budget for Claude thinking models.
		return { actualModel: requestedModel.replace(/-thinking$/i, ""), thinkingBudget: 1024 };
	}
	return { actualModel: requestedModel };
}
