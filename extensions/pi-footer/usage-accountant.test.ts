import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageAccountant } from "./usage-accountant.ts";

const T = 1_700_000_000_000;

function assistantMessage(responseId: string, output: number, timestamp = T) {
	return {
		role: "assistant",
		responseId,
		provider: "test",
		model: "test",
		timestamp,
		stopReason: "stop",
		content: [],
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as Parameters<UsageAccountant["recordAssistantEnd"]>[0];
}

test("message average uses the generation window, not turn elapsed time", () => {
	const accountant = new UsageAccountant();
	accountant.beginTurn(T);
	// Tool-call message at turn start, 30s tool execution, then a 1s / 200-token body message.
	accountant.recordStreamDelta("toolcall", "m1", undefined, T + 50);
	accountant.recordAssistantEnd(assistantMessage("m1", 10), T + 100);
	for (let i = 0; i < 10; i++) accountant.recordStreamDelta("x".repeat(800), "m2", undefined, T + 30_100 + i * 100);
	accountant.recordAssistantEnd(assistantMessage("m2", 200), T + 31_200);
	// 200 tokens over 1.0s of generation; the 30s tool gap must not dilute the average.
	assert.ok(Math.abs(accountant.lastTokensPerSec - 200) < 25);
});

test("calibration learns the CJK chars-per-token ratio from finished messages", () => {
	const accountant = new UsageAccountant();
	accountant.beginTurn(T);
	for (let i = 0; i < 10; i++) accountant.recordStreamDelta("가".repeat(80), "m1", undefined, T + i * 100);
	accountant.recordAssistantEnd(assistantMessage("m1", 800), T + 1_000); // ~1 token per Hangul char

	accountant.beginTurn(T + 2_000);
	for (let i = 0; i < 5; i++) accountant.recordStreamDelta("가".repeat(40), "m2", undefined, T + 2_000 + i * 100);
	// 200 Hangul chars ≈ 200 tokens; the uncalibrated len/4 estimate would say 50.
	assert.ok(accountant.liveEstimatedTokens > 150 && accountant.liveEstimatedTokens < 250);
});

test("CJK-aware base estimate is applied before any calibration exists", () => {
	const accountant = new UsageAccountant();
	accountant.beginTurn(T);
	accountant.recordStreamDelta("가".repeat(100), "m1", undefined, T + 10);
	assert.equal(accountant.liveEstimatedTokens, 100);
});

test("falls back to turn elapsed time when the generation window is too short", () => {
	const accountant = new UsageAccountant();
	accountant.beginTurn(T);
	accountant.recordStreamDelta("abcd", "m1", 100, T + 10_000);
	accountant.recordAssistantEnd(assistantMessage("m1", 100), T + 12_000);
	// Fallback: 100 tokens / 12s turn elapsed (turn start T -> end T+12s).
	assert.ok(Math.abs(accountant.lastTokensPerSec - 100 / 12) < 0.01);
});

test("usage-increment samples keep live speed accurate without calibration", () => {
	const accountant = new UsageAccountant();
	accountant.beginTurn(T);
	for (let i = 0; i < 10; i++) accountant.recordStreamDelta("abcd", "m1", (i + 1) * 20, T + i * 100);
	// The speed tracker itself is covered by live-speed.test.ts; here we assert clean accounting.
	assert.ok(accountant.recordAssistantEnd(assistantMessage("m1", 200), T + 1_200));
	assert.equal(accountant.streaming, false);
});

test("calibration discards implausible ratios", () => {
	const accountant = new UsageAccountant();
	accountant.beginTurn(T);
	for (let i = 0; i < 5; i++) accountant.recordStreamDelta("abcd", "m1", undefined, T + i * 100);
	// 20 chars -> base estimate 5; claiming 500 output tokens would be a ratio of 100.
	accountant.recordAssistantEnd(assistantMessage("m1", 500), T + 1_000);

	// The next message must still use the uncalibrated base estimate.
	accountant.beginTurn(T + 2_000);
	accountant.recordStreamDelta("abcd".repeat(25), "m2", undefined, T + 2_000);
	assert.equal(accountant.liveEstimatedTokens, 25);
});
