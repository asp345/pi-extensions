import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTokenPlan, TOKEN_PLANS } from "./plans.ts";
import { formatProviderQuota } from "./providers/quota-adapter.ts";
import type { UsageReport } from "./types.ts";

test("registers every supported provider", () => {
	assert.deepEqual(TOKEN_PLANS.map((plan) => plan.id).sort(), [
		"anthropic",
		"antigravity",
		"commandcode",
		"deepseek",
		"glm",
		"kimi",
		"minimax",
		"openai-codex",
		"opencode-go",
		"xai",
	]);
});
test("automatically resolves a provider plan", () => {
	assert.equal(resolveTokenPlan("openai-codex")?.id, "openai-codex");
	assert.equal(resolveTokenPlan("google-antigravity")?.id, "antigravity");
	assert.equal(resolveTokenPlan("unknown-provider"), null);
});

test("formats daily and weekly windows", () => {
	const report: UsageReport = {
		provider: "test",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "daily",
				label: "Daily",
				window: { id: "1d", label: "Daily", durationMs: 86_400_000 },
				amount: { unit: "percent", remainingFraction: 0.8 },
			},
			{
				id: "weekly",
				label: "Weekly",
				window: { id: "7d", label: "Weekly", durationMs: 604_800_000 },
				amount: { unit: "percent", remainingFraction: 0.4 },
			},
		],
	};
	const formatted = formatProviderQuota(report);
	assert.equal(formatted.display, "D: 80% W: 40%");
	assert.deepEqual(formatted.segments, { day: "D: 80%", week: "W: 40%" });
});
