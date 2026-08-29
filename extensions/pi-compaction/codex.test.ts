import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerCodexCompaction from "./codex.ts";

test("native compaction resumes through a custom continuation", () => {
	let turnEnd: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let agentSettled: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let aborted = false;
	let sent: { message: unknown; options: unknown } | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "turn_end") turnEnd = handler as typeof turnEnd;
			if (event === "agent_settled") agentSettled = handler as typeof agentSettled;
		},
		registerEntryRenderer() {},
		sendMessage(message: unknown, options: unknown) {
			sent = { message, options };
		},
	} as unknown as ExtensionAPI;
	registerCodexCompaction(pi, () => ({ nativeCodex: true, textMode: "prompt" }));

	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses" },
		hasUI: false,
		sessionManager: { getSessionId: () => "session" },
		getContextUsage: () => ({ percent: 90 }),
		hasPendingMessages: () => false,
		abort: () => {
			aborted = true;
		},
		compact: (options: Parameters<ExtensionContext["compact"]>[0]) => options?.onComplete?.({} as never),
	} as unknown as ExtensionContext;

	turnEnd?.({}, ctx);
	assert.equal(aborted, true);
	agentSettled?.({}, ctx);
	assert.deepEqual(sent, {
		message: {
			customType: "openai-codex-compaction-continuation",
			content: "Compaction completed. Continue.",
			display: true,
		},
		options: { triggerTurn: true, deliverAs: "followUp" },
	});
});
