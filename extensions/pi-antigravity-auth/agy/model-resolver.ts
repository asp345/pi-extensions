/**
 * Model resolution: base id + thinking tier → wire model id + thinking budget.
 * The service defines tiers as separate model ids (gemini-3.7-flash-low /
 * -medium / -high, each with its own thinkingBudget), so tier selection is
 * expressed through the wire model id. Budgets come from the live catalog
 * when available; captured agy 1.1.20 constants serve as fallback.
 */
import { getLiveModelCatalog } from "./models.ts";

interface ResolvedModel {
	actualModel: string;
	thinkingBudget?: number;
}

function findTier(baseId: string, tier: string | undefined): ResolvedModel | undefined {
	const entry = getLiveModelCatalog()?.find((model) => model.id === baseId);
	if (!entry?.tiers) return undefined;
	const found = entry.tiers.find((candidate) => candidate.tier === (tier ?? "medium"));
	return found ? { actualModel: found.wireModel, thinkingBudget: found.thinkingBudget } : undefined;
}

export function resolveModelForAntigravity(requestedModel: string, tier?: string): ResolvedModel {
	const id = requestedModel.replace(/^antigravity-/i, "").toLowerCase();
	if (/image|imagen/i.test(id)) return { actualModel: requestedModel };

	if (/^gemini-3\.1-pro/.test(id)) {
		return findTier("gemini-3.1-pro", tier) ?? { actualModel: "gemini-3.1-pro-low", thinkingBudget: 1001 };
	}
	if (/^gemini-3\.8-flash/.test(id)) {
		return (
			findTier("gemini-3.8-flash", tier) ?? {
				actualModel: `gemini-3.8-flash-${tier ?? "medium"}`,
				thinkingBudget: tier === "low" ? 1000 : tier === "high" ? -1 : 4000,
			}
		);
	}
	if (/^gemini-3\.7-flash/.test(id)) {
		return (
			findTier("gemini-3.7-flash", tier) ?? {
				actualModel: `gemini-3.7-flash-${tier ?? "medium"}`,
				thinkingBudget: tier === "low" ? 1000 : tier === "high" ? -1 : 4000,
			}
		);
	}
	if (/^gemini-3\.6-flash/.test(id)) {
		return (
			findTier("gemini-3.6-flash", tier) ?? {
				actualModel: `gemini-3.6-flash-${tier ?? "medium"}`,
				thinkingBudget: tier === "low" ? 1000 : tier === "high" ? -1 : 4000,
			}
		);
	}
	if (/^gemini-3\.5-flash/.test(id)) {
		return { actualModel: "gemini-3-flash-agent", thinkingBudget: 4000 };
	}
	if (/^gemini-3-flash/.test(id)) {
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
