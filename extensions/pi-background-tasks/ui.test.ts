import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRuntime, TaskEvent } from "./runtime.ts";

const { BackgroundUI } = await import("./ui.ts");

function exitEvent(): TaskEvent {
	return {
		type: "exit",
		task: {
			id: "bg-1",
			command: "printf done",
			title: "printf done",
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
			outputBytes: 5,
		},
		output: "done\n",
	};
}

test("task exits are delivered immediately as steering messages", async () => {
	const event = exitEvent();
	const deliveries: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		registerMessageRenderer: () => undefined,
		sendMessage: (message: unknown, options: unknown) => {
			deliveries.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const runtime = { get: (id: string) => (id === event.task.id ? event.task : undefined) } as BackgroundRuntime;
	const ui = new BackgroundUI(pi, runtime);

	ui.handleEvent(event);
	await Promise.resolve();

	assert.equal(deliveries.length, 1);
	assert.deepEqual(deliveries[0]?.options, { deliverAs: "steer", triggerTurn: true });
	assert.match(String((deliveries[0]?.message as { content?: unknown }).content), /Background task bg-1 finished/u);
});
