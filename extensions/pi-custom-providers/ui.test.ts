import assert from "node:assert/strict";
import { test } from "node:test";
import { type Choice, filterChoices } from "./ui.ts";

function catalog(size: number): Choice<string>[] {
	return Array.from({ length: size }, (_, index) => ({
		label: `moonshotai/model-${index}`,
		value: `moonshotai/model-${index}`,
		description: index % 2 === 0 ? "thinking high · text" : "no thinking · image",
	}));
}

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
});
