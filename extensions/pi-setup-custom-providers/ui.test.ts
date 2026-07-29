import assert from "node:assert/strict";
import { test } from "node:test";
import { type SelectItem, SelectList, visibleWidth } from "@earendil-works/pi-tui";
import { type Choice, filterChoices, MAX_VISIBLE_ROWS } from "./ui.ts";

const plainTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

function catalog(size: number): Choice<string>[] {
	return Array.from({ length: size }, (_, index) => ({
		label: `moonshotai/model-${index}`,
		value: `moonshotai/model-${index}`,
		description: index % 2 === 0 ? "thinking high · text" : "no thinking · image",
	}));
}

function rendered(choices: readonly Choice<string>[]): string[] {
	const items: SelectItem[] = choices.map((choice) => ({
		value: choice.value,
		label: choice.label,
		description: choice.description,
	}));
	const list = new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_ROWS), plainTheme);
	return list.render(80);
}

test("a large catalog renders inside a bounded viewport", () => {
	const lines = rendered(catalog(200));
	assert.ok(lines.length <= MAX_VISIBLE_ROWS + 1, `rendered ${lines.length} lines for 200 models`);
	for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});

test("filtering matches anywhere in the label or its detail line", () => {
	const choices = catalog(200);

	const byId = filterChoices(choices, "model-137");
	assert.deepEqual(
		byId.map((choice) => choice.value),
		["moonshotai/model-137"],
	);

	const byDetail = filterChoices(choices, "no thinking");
	assert.equal(byDetail.length, 100);

	assert.equal(filterChoices(choices, "").length, choices.length);
	assert.equal(filterChoices(choices, "nothing here").length, 0);
	assert.ok(rendered(byId).length <= MAX_VISIBLE_ROWS + 1);
});
