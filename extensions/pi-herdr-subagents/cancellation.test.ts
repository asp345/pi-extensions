import assert from "node:assert/strict";
import test from "node:test";
import { interpretExitSidecar } from "./completion.ts";
import { findLastAssistantMessage, findLastAssistantStopReason, type SessionEntry } from "./session.ts";
import { latestAssistantWasAborted } from "./subagent-done.ts";

function assistant(stopReason: string, text: string): SessionEntry {
	return {
		type: "message",
		id: stopReason,
		message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
	};
}

test("cancelled sidecars report failure", () => {
	assert.deepEqual(interpretExitSidecar({ type: "cancelled" }), {
		reason: "cancelled",
		exitCode: 1,
		errorMessage: "Subagent cancelled by user.",
	});
});

test("an aborted final assistant turn does not fall back to stale output", () => {
	const entries = [assistant("toolUse", "Starting review"), assistant("aborted", "")];
	assert.equal(findLastAssistantStopReason(entries), "aborted");
	assert.equal(findLastAssistantMessage(entries), null);
});

test("child shutdown tracking recognizes only the latest assistant turn", () => {
	assert.equal(
		latestAssistantWasAborted([
			{ role: "assistant", stopReason: "aborted" },
			{ role: "user" },
			{ role: "assistant", stopReason: "stop" },
		]),
		false,
	);
	assert.equal(latestAssistantWasAborted([{ role: "assistant", stopReason: "aborted" }]), true);
});
