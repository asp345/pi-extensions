import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTokenPlan, TOKEN_PLANS } from "./plans.ts";
import { formatUsageLimits } from "./providers/quota-adapter.ts";
import type { UsageLimit } from "./types.ts";

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
	const limits: UsageLimit[] = [
		{
			id: "daily",
			label: "Daily",
			window: { id: "1d", label: "Daily", durationMs: 86_400_000 },
			remainingFraction: 0.8,
		},
		{
			id: "weekly",
			label: "Weekly",
			window: { id: "7d", label: "Weekly", durationMs: 604_800_000 },
			remainingFraction: 0.4,
		},
	];
	assert.deepEqual(formatUsageLimits(limits)?.segments, { day: "D: 80%", week: "W: 40%" });
});
