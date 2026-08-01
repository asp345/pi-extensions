import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBackgroundTasksState } from "./events.ts";

test("parses valid running background task IDs", () => {
	assert.deepEqual(parseBackgroundTasksState({ runningTaskIds: ["bg-1", "bg-2", "bg-1"] }), {
		runningTaskIds: ["bg-1", "bg-2"],
	});
});

test("rejects malformed background task state", () => {
	for (const value of [
		undefined,
		null,
		[],
		{},
		{ runningTaskIds: undefined },
		{ runningTaskIds: "bg-1" },
		{ runningTaskIds: ["bg-1", 2] },
		{ runningTaskIds: [""] },
	]) {
		assert.equal(parseBackgroundTasksState(value), undefined);
	}
});
