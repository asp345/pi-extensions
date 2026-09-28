import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTierToPayload } from "./tier.ts";

test("service tiers produce the expected payload", () => {
	const payload = { model: "gpt-5.6-sol" };
	assert.equal(applyTierToPayload(payload, "default"), undefined);
	assert.deepEqual(applyTierToPayload(payload, "flex"), { model: "gpt-5.6-sol", service_tier: "flex" });
});
