import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageAccountant } from "./usage-accountant.ts";

const T = 1_700_000_000_000;

function assistantMessage(output: number) {
	return {
		role: "assistant",
		provider: "test",
		model: "test",
		timestamp: T,
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

test("message speed uses the generation window", () => {
	const accountant = new UsageAccountant();
	accountant.beginMessage();
	for (let i = 0; i <= 10; i++) accountant.recordStreamDelta(T + 30_000 + i * 100);
	accountant.recordAssistantEnd(assistantMessage(200));
	assert.equal(accountant.lastTokensPerSec, 200);
});
