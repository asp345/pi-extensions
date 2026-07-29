import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { interpretExitSidecar } from "./completion.ts";
import { __test__ } from "./index.ts";
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

test("stopping a subagent interrupts its pane and publishes cancellation", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagent-stop-"));
	const sessionFile = join(directory, "session.jsonl");
	const interrupted: string[] = [];
	try {
		assert.deepEqual(
			__test__.requestSubagentStop({ name: "review", surface: "pane-1", sessionFile }, (surface) =>
				interrupted.push(surface),
			),
			{ ok: true },
		);
		assert.deepEqual(interrupted, ["pane-1"]);
		assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "cancelled" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cancelled results are presented as cancellation rather than provider failure", () => {
	assert.match(
		__test__.resolveResultPresentation(
			{
				exitCode: 1,
				elapsed: 4,
				summary: "Subagent cancelled by user.",
				errorMessage: "Subagent cancelled by user.",
				cancelled: true,
			},
			"review",
		),
		/^Sub-agent "review" cancelled after 4s\.$/,
	);
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
