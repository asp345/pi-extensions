import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoal } from "./state.ts";

const { GoalRuntime } = await import("./runtime.ts");

function harness() {
	const sent: { customType: string; details?: unknown }[] = [];
	const pi = {
		appendEntry: () => undefined,
		sendMessage: async (message: { customType: string; details?: unknown }) => {
			sent.push(message);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
		},
	};
	const runtime = new GoalRuntime(pi);
	runtime.setGoal(createGoal("test objective"), ctx);
	return { runtime, ctx, sent };
}

const assistant = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
});

test("automatic continuation has no default turn limit", async () => {
	const { runtime, ctx, sent } = harness();
	const goal = runtime.goal;
	assert.ok(goal);
	goal.automaticTurns = 10_000;

	runtime.finishAgent([assistant("progress")]);
	await runtime.settled(ctx);

	assert.equal(goal.status, "active");
	assert.equal(sent.length, 1);
});

test("goal-owned background task completion re-drives automatic continuation", async () => {
	const { runtime, ctx, sent } = harness();
	await runtime.startPrompt(ctx);
	runtime.beforeAgentStart(sent[0]);
	await runtime.setRunningWork("background-tasks", ["bg-1"], ctx);
	runtime.finishAgent([assistant("waiting for background work")]);
	await runtime.settled(ctx);
	assert.equal(sent.length, 1);

	await runtime.setRunningWork("background-tasks", [], ctx);
	assert.equal(sent.length, 2);
});

test("any running background task defers automatic continuation", async () => {
	const { runtime, ctx, sent } = harness();
	await runtime.setRunningWork("background-tasks", ["bg-1"], ctx);
	runtime.finishAgent([assistant("progress")]);
	await runtime.settled(ctx);
	assert.equal(sent.length, 0);

	await runtime.setRunningWork("background-tasks", [], ctx);
	assert.equal(sent.length, 1);
});

test("goal-owned task that starts after agent finishes still defers continuation", async () => {
	const { runtime, ctx, sent } = harness();
	await runtime.startPrompt(ctx);
	runtime.beforeAgentStart(sent[0]);
	runtime.finishAgent([assistant("waiting for background work")]);
	// Background task event arrives after finishAgent but before settled (race)
	await runtime.setRunningWork("background-tasks", ["bg-2"], ctx);
	await runtime.settled(ctx);
	assert.equal(sent.length, 1);

	await runtime.setRunningWork("background-tasks", [], ctx);
	assert.equal(sent.length, 2);
});

test("continuation dropped during compaction is re-driven after compaction", async () => {
	const { runtime, ctx, sent } = harness();
	let idle = false;
	ctx.isIdle = () => idle;

	await runtime.startPrompt(ctx);
	assert.equal(sent.length, 0);

	idle = true;
	await runtime.settleAfterCompaction(ctx);
	assert.equal(sent.length, 1);
});

test("compaction re-drive does not resume a paused goal", async () => {
	const { runtime, ctx, sent } = harness();
	let idle = false;
	ctx.isIdle = () => idle;

	await runtime.startPrompt(ctx);
	runtime.pause(ctx);
	idle = true;
	await runtime.settleAfterCompaction(ctx);

	assert.equal(sent.length, 0);
	assert.equal(runtime.goal?.status, "paused");
});

test("goal-owned background task completion during compaction is re-driven after compaction", async () => {
	const { runtime, ctx, sent } = harness();
	await runtime.startPrompt(ctx);
	runtime.beforeAgentStart(sent[0]);
	await runtime.setRunningWork("background-tasks", ["bg-1"], ctx);
	runtime.finishAgent([assistant("waiting for background work")]);
	await runtime.settled(ctx);
	assert.equal(sent.length, 1);

	let idle = false;
	ctx.isIdle = () => idle;
	await runtime.setRunningWork("background-tasks", [], ctx);
	assert.equal(sent.length, 1);

	idle = true;
	await runtime.settleAfterCompaction(ctx);
	assert.equal(sent.length, 2);
});
