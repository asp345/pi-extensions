import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepBlockReason } from "./guard.ts";

const BLOCKED = (command: string): void => {
	const reason = sleepBlockReason(command);
	assert.ok(reason !== null, `expected block: ${command}`);
	assert.ok(reason);
	assert.match(reason, /Do not sleep to wait/);
	assert.match(reason, /Launch a background task and end the turn/);
};

const ALLOWED = (command: string): void => {
	assert.equal(sleepBlockReason(command), null, `expected allow: ${command}`);
};

test("blocks long and unknown sleeps", () => {
	BLOCKED("sleep 30");
	BLOCKED("sleep 1m");
	BLOCKED("sleep $N");
	const reason = sleepBlockReason("sleep 60");
	assert.match(reason ?? "", /Blocked: sleep 60s \(max 30s\)/);
	ALLOWED("sleep 9");
	ALLOWED("sleep 29");
});

test("blocks nested sleeps", () => {
	BLOCKED("sleep 15 && sleep 15");
	BLOCKED("echo $(sleep 30)");
	BLOCKED("if true; then sleep 30; fi");
});

test("allows short, quoted, and explicit sleeps", () => {
	ALLOWED("echo hi");
	ALLOWED('echo "sleep 10"');
	ALLOWED("sleep -- 20");
});
