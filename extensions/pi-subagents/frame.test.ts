import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { frame, innerWidth, viewport } from "./frame.ts";

const theme = { fg: (_color: "accent" | "border", text: string) => text, bold: (text: string) => text };
const plain = (line: string): string => line.replaceAll(/\u001b\[[0-9;]*m/gu, "");

test("the viewport shows the tail and keeps a fixed height", () => {
	const lines = ["a", "b", "c"];
	assert.deepEqual(viewport(lines, 2, 0), { lines: ["b", "c"], scroll: 0 });
	assert.deepEqual(viewport(lines, 5, 0), { lines: ["a", "b", "c", "", ""], scroll: 0 });
	assert.deepEqual(viewport(lines, 0, 0), { lines: [], scroll: 0 });
});

test("scrolling walks back from the bottom and clamps at the top", () => {
	const lines = ["a", "b", "c", "d"];
	assert.deepEqual(viewport(lines, 2, 1), { lines: ["b", "c"], scroll: 1 });
	assert.deepEqual(viewport(lines, 2, 99), { lines: ["a", "b"], scroll: 2 });
	assert.deepEqual(viewport(lines, 4, 3), { lines: ["a", "b", "c", "d"], scroll: 0 });
});

test("every framed line is exactly as wide as the box", () => {
	const lines = frame(["short", "\u001b[31mred\u001b[0m", "x".repeat(40)], 20, theme, "Explore");
	assert.equal(lines.length, 5);
	for (const line of lines) assert.equal(visibleWidth(line), 20);
	assert.match(lines[0], /^╭ Explore ─+╮$/u);
	assert.equal(plain(lines[1]), `│ short${" ".repeat(11)} │`);
	assert.match(lines.at(-1) ?? "", /^╰─+╯$/u);
	assert.equal(innerWidth(20), 16);
});

test("a title that cannot fit is truncated, and a box narrower than the border degrades to text", () => {
	const [titled] = frame([], 14, theme, "a very long agent title");
	assert.equal(visibleWidth(titled), 14);
	assert.match(plain(titled), /^╭ .*╮$/u);
	assert.deepEqual(frame(["content"], 4, theme, "t").map(plain), ["c..."]);
});

test("tabs are expanded so the border cannot be pushed out of the box", () => {
	const [, tabbed] = frame(["a\tb"], 20, theme, "t");
	assert.ok(!tabbed.includes("\t"));
	assert.equal(visibleWidth(tabbed), 20);
	assert.equal(plain(tabbed), `│ a   b${" ".repeat(11)} │`);
});

test("content keeps the cursor marker and closes styling before the padding", () => {
	const marker = "\u001b_pi:c\u0007";
	const [, line] = frame([`ab${marker}`, "\u001b[41mbg"], 12, theme, "t");
	assert.ok(line.includes(marker));
	assert.equal(visibleWidth(line), 12);
	const [, , coloured] = frame([`ab${marker}`, "\u001b[41mbg"], 12, theme, "t");
	assert.match(coloured, /\u001b\[0m {6}/u);
});
