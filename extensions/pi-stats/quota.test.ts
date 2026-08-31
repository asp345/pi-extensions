import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatTokenPlanDisplay } from "./quota.ts";

test("formats reset durations", () => {
	assert.equal(formatDuration(90 * 60 * 1000), "1h 30m");
	assert.equal(formatDuration(8 * 24 * 60 * 60 * 1000), "1w 1d");
});

test("formats five-hour and weekly quota", () => {
	assert.equal(formatTokenPlanDisplay(75.4, 42.1), "5h: 75% W: 42%");
});
