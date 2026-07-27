import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BackgroundRuntime, type RuntimeOptions, type TaskEvent } from "./runtime.ts";

interface Harness {
	runtime: BackgroundRuntime;
	events: TaskEvent[];
	updates: () => number;
}

function createHarness(options?: RuntimeOptions): Harness {
	const events: TaskEvent[] = [];
	let updateCount = 0;
	const runtime = new BackgroundRuntime(
		(event) => events.push(event),
		() => {
			updateCount++;
		},
		options,
	);
	return { runtime, events, updates: () => updateCount };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await delay(20);
	}
}

test("decodes multibyte UTF-8 split across stream chunks", async () => {
	const { runtime } = createHarness();
	try {
		const task = runtime.start("printf '\\xe2\\x82'; sleep 0.3; printf '\\xac'", process.cwd());
		await waitFor(() => runtime.get(task.id)?.status !== "running");
		assert.equal(runtime.output(task.id), "€");
	} finally {
		runtime.shutdown();
	}
});

test("emits exit event with final status and exit code", async () => {
	const { runtime, events } = createHarness();
	try {
		const task = runtime.start("exit 3", process.cwd());
		await waitFor(() => events.some((event) => event.type === "exit"));
		const exit = events.find((event) => event.type === "exit");
		assert.equal(exit?.task.id, task.id);
		assert.equal(exit?.task.status, "failed");
		assert.equal(exit?.task.exitCode, 3);
		assert.equal(events.filter((event) => event.type === "exit").length, 1);
	} finally {
		runtime.shutdown();
	}
});

test("throttled output notifications are not starved by steady output", async () => {
	const { runtime, events } = createHarness({ notifyDebounceMs: 100, notifyMaxWaitMs: 300 });
	try {
		const loop = Array.from({ length: 30 }, () => "printf x; sleep 0.05").join("; ");
		const task = runtime.start(loop, process.cwd());
		await waitFor(() => events.some((event) => event.type === "exit"));
		const outputs = events.filter((event) => event.type === "output");
		assert.ok(outputs.length >= 2, `expected at least 2 output events, got ${outputs.length}`);
		for (const event of outputs) {
			assert.equal(event.task.id, task.id);
			assert.equal(event.task.status, "running");
			assert.ok(event.output.length > 0);
		}
	} finally {
		runtime.shutdown();
	}
});

test("clear removes finished tasks and does not recreate log files", async () => {
	const { runtime } = createHarness();
	try {
		const task = runtime.start("printf done", process.cwd());
		await waitFor(() => runtime.get(task.id)?.status === "completed");
		assert.ok(existsSync(task.logFile));
		assert.equal(runtime.clear(), 1);
		assert.equal(runtime.get(task.id), undefined);
		assert.ok(!existsSync(task.logFile));
		await delay(200);
		assert.ok(!existsSync(task.logFile));
	} finally {
		runtime.shutdown();
	}
});

test("shutdown clears the task map and suppresses late events", async () => {
	const { runtime, events, updates } = createHarness();
	const task = runtime.start("sleep 5", process.cwd());
	await waitFor(() => (runtime.get(task.id)?.pid ?? 0) > 0);
	runtime.shutdown();
	assert.equal(runtime.list().length, 0);
	const eventCount = events.length;
	const updateCount = updates();
	await delay(300);
	assert.equal(events.length, eventCount);
	assert.equal(updates(), updateCount);
	assert.ok(!events.some((event) => event.type === "exit"));
	assert.ok(!existsSync(task.logFile));
});

test("a new session can reactivate the runtime after shutdown", async () => {
	const { runtime, events } = createHarness();
	runtime.shutdown();
	runtime.activate();
	const task = runtime.start("printf resumed", process.cwd());
	await waitFor(() => events.some((event) => event.type === "exit" && event.task.id === task.id));
	assert.equal(runtime.output(task.id), "resumed");
	runtime.shutdown();
});
