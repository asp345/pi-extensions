import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentOptions,
	cycleOption,
	handleSelectorKey,
	MAIN_OPTION_ID,
	mainOption,
	type SelectorOption,
	type SelectorState,
} from "./selector.ts";

const options = (count: number): SelectorOption[] =>
	agentOptions(
		Array.from({ length: count }, (_value, index) => ({
			id: `id-${index}-0000000000`,
			type: `Agent${index}`,
			model: `provider/model-${index}`,
			turns: index,
			toolUses: index,
		})),
	);

const state = (): SelectorState => ({ active: false, index: 0 });

test("agent options show the active model beside the agent name", () => {
	assert.equal(options(1)[0]?.label, "Agent0 · provider/model-0");
});

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

test("non-empty editor down passes through and shifted arrows bypass pending selection", () => {
	const s = state();
	assert.equal(handleSelectorKey(s, "down", options(2), false).consume, false);
	assert.equal(handleSelectorKey(s, "shift+down", options(2), false).consume, false);
	assert.equal(handleSelectorKey(s, "shift+up", options(2), false).consume, false);
	assert.equal(s.active, false);
});

test("navigation clamps, up at first row deactivates, enter commits pending selection", () => {
	const s = state();
	handleSelectorKey(s, "down", options(3), true);
	handleSelectorKey(s, "down", options(3), false);
	handleSelectorKey(s, "down", options(3), false);
	assert.equal(s.index, 2);
	const committed = handleSelectorKey(s, "enter", options(3), false);
	assert.equal(committed.consume, true);
	assert.equal(committed.commit?.id, "id-2-0000000000");
	assert.equal(s.active, false);

	handleSelectorKey(s, "down", options(3), true);
	assert.equal(handleSelectorKey(s, "up", options(3), false).consume, true);
	assert.equal(s.active, false);
});

test("escape cancels selector state and is consumed before host escape handling", () => {
	const s = state();
	handleSelectorKey(s, "down", options(2), true);
	const outcome = handleSelectorKey(s, "escape", options(2), false);
	assert.equal(outcome.consume, true);
	assert.equal(outcome.commit, undefined);
	assert.equal(s.active, false);
});

test("other input deactivates without consuming so it reaches the editor", () => {
	const s = state();
	handleSelectorKey(s, "down", options(2), true);
	assert.equal(handleSelectorKey(s, undefined, options(2), false).consume, false);
	assert.equal(s.active, false);
});

test("main option commits with the synthetic id", () => {
	const s = state();
	const list = [mainOption(), ...options(1)];
	handleSelectorKey(s, "down", list, true);
	assert.equal(handleSelectorKey(s, "enter", list, false).commit?.id, MAIN_OPTION_ID);
});

test("shifted arrows cycle and wrap direct selections", () => {
	const list = [mainOption(), ...options(2)];
	assert.equal(cycleOption(list, MAIN_OPTION_ID, "next")?.id, "id-0-0000000000");
	assert.equal(cycleOption(list, "id-0-0000000000", "next")?.id, "id-1-0000000000");
	assert.equal(cycleOption(list, "id-1-0000000000", "next")?.id, MAIN_OPTION_ID);
	assert.equal(cycleOption(list, MAIN_OPTION_ID, "previous")?.id, "id-1-0000000000");
	assert.equal(cycleOption(options(2), undefined, "next")?.id, "id-0-0000000000");
	assert.equal(cycleOption(options(2), undefined, "previous")?.id, "id-1-0000000000");
});

test("index clamps when options shrink between events", () => {
	const s: SelectorState = { active: true, index: 5 };
	handleSelectorKey(s, "down", options(2), false);
	assert.equal(s.index, 1);
});
