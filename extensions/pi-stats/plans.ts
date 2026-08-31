import { anthropicQuotaPlan } from "./providers/anthropic.ts";
import { antigravityQuotaPlan } from "./providers/antigravity.ts";
import { commandCodeQuotaPlan } from "./providers/command-code.ts";
import { deepseekQuotaPlan } from "./providers/deepseek.ts";
import { glmQuotaPlan } from "./providers/glm.ts";
import { kimiQuotaPlan } from "./providers/kimi.ts";
import { minimaxQuotaPlan } from "./providers/minimax.ts";
import { openaiCodexQuotaPlan } from "./providers/openai-codex.ts";
import { openCodeGoQuotaPlan } from "./providers/opencode-go.ts";
import { xaiQuotaPlan } from "./providers/xai.ts";
import type { TokenPlan } from "./quota.ts";

export const TOKEN_PLANS: TokenPlan[] = [
	minimaxQuotaPlan,
	glmQuotaPlan,
	kimiQuotaPlan,
	deepseekQuotaPlan,
	openCodeGoQuotaPlan,
	commandCodeQuotaPlan,
	anthropicQuotaPlan,
	openaiCodexQuotaPlan,
	xaiQuotaPlan,
	antigravityQuotaPlan,
];

export function resolveTokenPlan(provider: string, configuredPlanId: string | null | undefined): TokenPlan | null {
	if (configuredPlanId === null) return null;
	if (configuredPlanId) {
		return TOKEN_PLANS.find((plan) => plan.id === configuredPlanId) ?? null;
	}
	return TOKEN_PLANS.find((plan) => plan.matchProviders.includes(provider)) ?? null;
}
