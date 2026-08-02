import assert from "node:assert/strict";
import { test } from "node:test";
import { readBytes } from "./storage.ts";

test("bounded response reads release their stream reader", async () => {
	const response = new Response(new Uint8Array([1, 2, 3]));
	assert.deepEqual([...(await readBytes(response, 3))], [1, 2, 3]);
	assert.equal(response.body?.locked, false);
});

test("oversized response reads cancel and release their stream reader", async () => {
	let cancelled = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3, 4]));
			},
			cancel() {
				cancelled = true;
			},
		}),
	);
	await assert.rejects(readBytes(response, 3), /too large/u);
	assert.equal(cancelled, true);
	assert.equal(response.body?.locked, false);
});
