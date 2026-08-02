import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationQueue } from "./notifications.ts";

const turn = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("completion notifications are delivered at most once", async () => {
	const deliveries: Array<Map<string, number>> = [];
	const queue = new NotificationQueue<number>((batch) => deliveries.push(new Map(batch)));

	queue.enqueue("agent-1", 1);
	queue.enqueue("agent-1", 1);
	await turn();
	await turn();

	assert.deepEqual(deliveries, [new Map([["agent-1", 1]])]);
});

test("completions arriving during delivery are scheduled separately", async () => {
	const deliveries: Array<Map<string, number>> = [];
	let queue: NotificationQueue<number>;
	queue = new NotificationQueue<number>((batch) => {
		deliveries.push(new Map(batch));
		if (batch.has("agent-1")) queue.enqueue("agent-2", 2);
	});

	queue.enqueue("agent-1", 1);
	await turn();
	await turn();

	assert.deepEqual(deliveries, [new Map([["agent-1", 1]]), new Map([["agent-2", 2]])]);
});
