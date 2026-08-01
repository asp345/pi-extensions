import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BackgroundRuntime, type TaskEvent } from "./runtime.ts";

interface Harness {
	runtime: BackgroundRuntime;
	events: TaskEvent[];
	states: string[][];
	updates: () => number;
}

function createHarness(): Harness {
	const events: TaskEvent[] = [];
	const states: string[][] = [];
	let updateCount = 0;
	const runtime = new BackgroundRuntime(
		(event) => events.push(event),
		() => {
			updateCount++;
		},
		(runningTaskIds) => states.push([...runningTaskIds]),
	);
	return { runtime, events, states, updates: () => updateCount };
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

test("publishes notified task state only at lifecycle transitions", async () => {
	const { runtime, states } = createHarness();
	try {
		const task = runtime.start("sleep 0.2", process.cwd(), { notify: false });
		assert.deepEqual(states, []);
		assert.ok(runtime.promote(task.id));
		assert.deepEqual(states, [[task.id]]);
		await waitFor(() => runtime.get(task.id)?.status !== "running");
		assert.deepEqual(states, [[task.id], []]);
	} finally {
		runtime.shutdown();
	}
});

test("quiet tasks emit no events and waitForExit delivers the result", async () => {
	const { runtime, events } = createHarness();
	try {
		const task = runtime.start("printf hi", process.cwd(), { notify: false });
		const result = await runtime.waitForExit(task.id, 5_000);
		assert.equal(result?.task.id, task.id);
		assert.equal(result?.task.status, "completed");
		assert.equal(result?.output, "hi");
		await delay(100);
		assert.equal(events.length, 0);
		assert.equal(runtime.get(task.id)?.notify, false);
		assert.ok(runtime.discard(task.id));
		assert.equal(runtime.get(task.id), undefined);
		assert.ok(!existsSync(task.logFile));
	} finally {
		runtime.shutdown();
	}
});

test("waitForExit times out, then promotion restores normal notifications", async () => {
	const { runtime, events } = createHarness();
	try {
		const task = runtime.start("sleep 0.3; printf done", process.cwd(), { notify: false });
		assert.equal(await runtime.waitForExit(task.id, 50), null);
		assert.equal(runtime.get(task.id)?.status, "running");
		assert.ok(runtime.promote(task.id));
		assert.equal(runtime.get(task.id)?.notify, true);
		assert.ok(!runtime.discard(task.id));
		await waitFor(() => events.some((event) => event.type === "exit" && event.task.id === task.id));
	} finally {
		runtime.shutdown();
	}
});

test("promoting an already finished quiet task emits the exit event late", async () => {
	const { runtime, events } = createHarness();
	try {
		const task = runtime.start("exit 0", process.cwd(), { notify: false });
		await waitFor(() => runtime.get(task.id)?.status === "completed");
		assert.equal(events.length, 0);
		assert.ok(runtime.promote(task.id));
		assert.equal(events.filter((event) => event.type === "exit").length, 1);
	} finally {
		runtime.shutdown();
	}
});

test("waitForExit resolves null when the abort signal fires", async () => {
	const { runtime } = createHarness();
	try {
		const task = runtime.start("sleep 5", process.cwd(), { notify: false });
		const controller = new AbortController();
		const wait = runtime.waitForExit(task.id, 10_000, controller.signal);
		setTimeout(() => controller.abort(), 50).unref();
		assert.equal(await wait, null);
		runtime.discard(task.id);
		assert.equal(runtime.get(task.id), undefined);
	} finally {
		runtime.shutdown();
	}
});
