import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepBlockReason } from "./guard.ts";

const BLOCKED = (command: string): void => {
	const reason = sleepBlockReason(command);
	assert.ok(reason !== null, `expected block: ${command}`);
	assert.match(reason!, /Do not sleep to wait/);
	assert.match(reason!, /sleep -- <seconds>/);
};

const ALLOWED = (command: string): void => {
	assert.equal(sleepBlockReason(command), null, `expected allow: ${command}`);
};

test("blocks long and unknown sleeps", () => {
	BLOCKED("sleep 10");
	BLOCKED("sleep 1m");
	BLOCKED("sleep $N");
	const reason = sleepBlockReason("sleep 30");
	assert.match(reason ?? "", /Blocked: sleep 30s \(max 10s\)/);
	ALLOWED("sleep 9");
});

test("blocks nested sleeps", () => {
	BLOCKED("sleep 10 && echo done");
	BLOCKED("echo $(sleep 10)");
	BLOCKED("if true; then sleep 10; fi");
});

test("allows short, quoted, and explicit sleeps", () => {
	ALLOWED("echo hi");
	ALLOWED('echo "sleep 10"');
	ALLOWED("sleep -- 20");
});
