import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectSleep, sleepBlockReason } from "./guard.ts";

const BLOCKED = (command: string): void => {
	const reason = sleepBlockReason(command);
	assert.ok(reason !== null, `expected block: ${command}`);
	assert.match(reason!, /Do not sleep to wait/);
	assert.match(reason!, /sleep -- <seconds>/);
};

const ALLOWED = (command: string): void => {
	assert.equal(sleepBlockReason(command), null, `expected allow: ${command}`);
};

test("blocks sleep at or above 10 seconds", () => {
	BLOCKED("sleep 10");
	BLOCKED("sleep 11");
	BLOCKED("sleep 10s");
	BLOCKED("sleep 1m");
	BLOCKED("sleep 1m 30s");
	BLOCKED("sleep 5 5");
	BLOCKED("sleep 0.2m");
	BLOCKED("sleep 10.5");
	BLOCKED("sleep inf");
	ALLOWED("sleep 9");
	ALLOWED("sleep 0.5");
	ALLOWED("sleep 5");
	ALLOWED("sleep 0.1m");
});

test("blocks sleep in nested and chained positions", () => {
	BLOCKED("sleep 10 &");
	BLOCKED("sleep 10 && echo done");
	BLOCKED("sleep 10; echo done");
	BLOCKED("sleep 10 > log");
	BLOCKED("echo $(sleep 10)");
	BLOCKED("VAR=$(sleep 10)");
	BLOCKED("f() { sleep 10; }; f");
	BLOCKED("(sleep 10)");
	BLOCKED("if true; then sleep 10; fi");
	BLOCKED("for i in 1; do sleep 10; done");
	BLOCKED("cat <<EOF\n$(sleep 10)\nEOF");
	BLOCKED("\\sleep 10");
	BLOCKED('sleep "10"');
	BLOCKED("sleep '1'0");
	BLOCKED("sleep 1\\0");
});

test("blocks sleep with unevaluable arguments", () => {
	BLOCKED("sleep $N");
	BLOCKED("sleep $((10))");
	BLOCKED("sleep $(echo 10)");
	BLOCKED("sleep ${N:-10}");
	BLOCKED("sleep {1,2}0");
});

test("allows non-sleep commands and quoted text", () => {
	ALLOWED("echo hi");
	ALLOWED('echo "sleep 10"');
	ALLOWED("grep sleep .");
	ALLOWED("cat <<EOF\nsleep 10\nEOF");
	ALLOWED("");
});

test("allows deliberate sleep via -- separator", () => {
	ALLOWED("sleep -- 20");
	ALLOWED("sleep -- 5");
	ALLOWED("sleep -- 1m");
});

test("documents wrapper-form gaps", () => {
	ALLOWED("xargs sleep 10");
	ALLOWED("command sleep 10");
});

test("reports structured inspection", () => {
	assert.deepEqual(inspectSleep("sleep 9"), { totalSeconds: 9, hasUnknown: false });
	assert.deepEqual(inspectSleep("echo hi"), { totalSeconds: 0, hasUnknown: false });
	assert.deepEqual(inspectSleep(""), { totalSeconds: 0, hasUnknown: false });
	const unknown = inspectSleep("sleep $N");
	assert.equal(unknown.hasUnknown, true);
	const nested = inspectSleep("echo $(sleep 9)");
	assert.deepEqual(nested, { totalSeconds: 9, hasUnknown: false });
});

test("rejection message states the duration and limit", () => {
	const reason = sleepBlockReason("sleep 30");
	assert.match(reason ?? "", /Blocked: sleep 30s \(max 10s\)/);
	assert.equal(sleepBlockReason("sleep 9"), null);
});
