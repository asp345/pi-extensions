import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentOptions,
	handleSelectorKey,
	MAIN_OPTION_ID,
	mainOption,
	type PaddingState,
	type SelectorOption,
	type SelectorState,
	stablePadding,
} from "./selector.ts";

const options = (count: number): SelectorOption[] =>
	agentOptions(
		Array.from({ length: count }, (_value, index) => ({
			id: `id-${index}-0000000000`,
			type: `Agent${index}`,
			turns: index,
			toolUses: index,
		})),
	);

const state = (): SelectorState => ({ active: false, index: 0 });

test("no options: nothing is consumed and state deactivates", () => {
	const s: SelectorState = { active: true, index: 3 };
	assert.deepEqual(handleSelectorKey(s, "shift+down", [], false), { consume: false });
	assert.equal(s.active, false);
});

test("empty editor plain down activates; plain up stays with editor history", () => {
	const s = state();
	assert.equal(handleSelectorKey(s, "up", options(2), true).consume, false);
	assert.equal(s.active, false);
	assert.equal(handleSelectorKey(s, "down", options(2), true).consume, true);
	assert.equal(s.active, true);
	assert.equal(s.index, 0);
});

test("non-empty editor: plain down passes through, shift+up/down activate", () => {
	const s = state();
	assert.equal(handleSelectorKey(s, "down", options(2), false).consume, false);
	assert.equal(s.active, false);
	assert.equal(handleSelectorKey(s, "shift+down", options(2), false).consume, true);
	assert.equal(s.active, true);
	s.active = false;
	assert.equal(handleSelectorKey(s, "shift+up", options(2), false).consume, true);
	assert.equal(s.active, true);
});

test("navigation clamps, up at first row deactivates, enter commits pending selection", () => {
	const s = state();
	handleSelectorKey(s, "shift+down", options(3), false);
	handleSelectorKey(s, "down", options(3), false);
	handleSelectorKey(s, "shift+down", options(3), false);
	handleSelectorKey(s, "down", options(3), false);
	assert.equal(s.index, 2);
	const committed = handleSelectorKey(s, "enter", options(3), false);
	assert.equal(committed.consume, true);
	assert.equal(committed.commit?.id, "id-2-0000000000");
	assert.equal(s.active, false);

	handleSelectorKey(s, "shift+down", options(3), false);
	assert.equal(handleSelectorKey(s, "up", options(3), false).consume, true);
	assert.equal(s.active, false);
});

test("escape cancels selector state and is consumed before host escape handling", () => {
	const s = state();
	handleSelectorKey(s, "shift+down", options(2), false);
	const outcome = handleSelectorKey(s, "escape", options(2), false);
	assert.equal(outcome.consume, true);
	assert.equal(outcome.commit, undefined);
	assert.equal(s.active, false);
});

test("other input deactivates without consuming so it reaches the editor", () => {
	const s = state();
	handleSelectorKey(s, "shift+down", options(2), false);
	assert.equal(handleSelectorKey(s, undefined, options(2), false).consume, false);
	assert.equal(s.active, false);
});

test("main option commits with the synthetic id", () => {
	const s = state();
	const list = [mainOption(), ...options(1)];
	handleSelectorKey(s, "shift+down", list, false);
	assert.equal(handleSelectorKey(s, "enter", list, false).commit?.id, MAIN_OPTION_ID);
});

test("index clamps when options shrink between events", () => {
	const s: SelectorState = { active: true, index: 5 };
	handleSelectorKey(s, "down", options(2), false);
	assert.equal(s.index, 1);
});

test("padding is frozen while streaming and recomputed on rows or record change", () => {
	const p: PaddingState = { value: 0 };
	assert.equal(stablePadding(p, "a", 40, 10), 30);
	assert.equal(stablePadding(p, "a", 40, 25), 30);
	assert.equal(stablePadding(p, "a", 40, 90), 30);
	assert.equal(stablePadding(p, "a", 20, 90), 0);
	assert.equal(stablePadding(p, "b", 20, 5), 15);
	assert.equal(stablePadding(p, "b", 20, 8), 15);
	assert.equal(stablePadding(p, undefined, 20, 4), 16);
});
