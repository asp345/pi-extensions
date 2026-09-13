import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopGuard, loopBlockReason } from "./guard.ts";

const OUT = [{ type: "text", text: "same" }];

test("block reason mentions repetition", () => {
	assert.ok(loopBlockReason(4).includes("4 times"));
});

test("blocks only after 3 identical completed calls", () => {
	const guard = new LoopGuard();
	guard.record("background_task", { action: "list" }, OUT);
	guard.record("background_task", { action: "list" }, OUT);
	guard.record("background_task", { action: "list" }, OUT);
	assert.equal(guard.shouldBlock("background_task", { action: "list" }), true);
});

test("does not block before limit or on changed input or output", () => {
	const guard = new LoopGuard();
	guard.record("background_task", { action: "list" }, OUT);
	guard.record("background_task", { action: "list" }, OUT);
	assert.equal(guard.shouldBlock("background_task", { action: "list" }), false);

	const changed = new LoopGuard();
	changed.record("background_task", { action: "read", id: "bg-1" }, OUT);
	changed.record("background_task", { action: "read", id: "bg-1" }, OUT);
	changed.record("background_task", { action: "read", id: "bg-1" }, OUT);
	changed.record("background_task", { action: "read", id: "bg-1" }, [{ type: "text", text: "new" }]);
	assert.equal(changed.shouldBlock("background_task", { action: "read", id: "bg-1" }), false);
	assert.equal(changed.shouldBlock("background_task", { action: "list" }), false);
});
