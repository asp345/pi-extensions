import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTierToPayload, tierCostMultiplier } from "./tier.ts";

test("service tiers produce the expected payload and cost multiplier", () => {
	const payload = { model: "gpt-5.6-sol" };
	assert.equal(applyTierToPayload(payload, "default"), undefined);
	assert.deepEqual(applyTierToPayload(payload, "flex"), { model: "gpt-5.6-sol", service_tier: "flex" });
	assert.equal(tierCostMultiplier("flex", "gpt-5.6-sol"), 0.5);
	assert.equal(tierCostMultiplier("priority", "gpt-5.5"), 2.5);
});
