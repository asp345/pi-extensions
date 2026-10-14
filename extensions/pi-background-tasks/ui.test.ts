import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundRuntime, TaskEvent } from "./runtime.ts";

const { BackgroundUI } = await import("./ui.ts");

function exitEvent(): TaskEvent {
	return {
		type: "exit",
		task: {
			id: "bg-1",
			command: "printf done",
			notify: true,
			heartbeatMs: 1_800_000,
			cwd: process.cwd(),
			pid: 123,
			logFile: "/tmp/bg-1.log",
			startedAt: 1,
			updatedAt: 2,
			lastOutputAt: 2,
			status: "completed",
			exitCode: 0,
			timedOut: false,
			stopReason: null,
		},
		output: "done\n",
	};
}

test("task exits start a turn when the session is idle", async () => {
	const event = exitEvent();
	const deliveries: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		sendMessage: (message: unknown, options: unknown) => {
			deliveries.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const runtime = {
		get: (id: string) => (id === event.task.id ? event.task : undefined),
		list: () => [],
	} as unknown as BackgroundRuntime;
	const ui = new BackgroundUI(pi, runtime);
	ui.attach({ isIdle: () => true } as unknown as ExtensionContext);

	ui.handleEvent(event);
	await Promise.resolve();

	assert.equal(deliveries.length, 1);
	assert.deepEqual(deliveries[0]?.options, { triggerTurn: true });
	const delivered = deliveries[0];
	assert.ok(delivered);
	assert.match(String((delivered.message as { content?: unknown }).content), /Background task bg-1 finished/u);
});
