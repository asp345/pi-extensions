import assert from "node:assert/strict";
import { test } from "node:test";

const { applyEdits, offsetAt } = await import("./protocol.ts");

const position = (line: number, character: number) => ({ line, character });

test("applies valid LSP edits with strict positions", () => {
	assert.equal(
		applyEdits("one\ntwo\n", [{ range: { start: position(1, 0), end: position(1, 3) }, newText: "second" }]),
		"one\nsecond\n",
	);
	assert.equal(offsetAt("one\r\ntwo", position(1, 3)), 8);
});

test("rejects invalid and reversed LSP edit ranges", () => {
	const text = "one\ntwo";
	for (const invalid of [position(-1, 0), position(0, -1), position(0.5, 0), position(2, 0), position(0, 4)]) {
		assert.throws(() => offsetAt(text, invalid), /LSP edit/u);
	}
	assert.throws(
		() => applyEdits(text, [{ range: { start: position(1, 2), end: position(0, 1) }, newText: "x" }]),
		/range start is after/u,
	);
});
