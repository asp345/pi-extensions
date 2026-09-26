import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, quotaSegments } from "./quota.ts";

test("formats reset durations", () => {
	assert.equal(formatDuration(90 * 60 * 1000), "1h 30m");
	assert.equal(formatDuration(8 * 24 * 60 * 60 * 1000), "1w 1d");
});

test("formats five-hour and weekly quota", () => {
	assert.deepEqual(quotaSegments({ fiveHour: 75.4, week: 42.1 }), { fiveHour: "5h: 75%", week: "W: 42%" });
});
