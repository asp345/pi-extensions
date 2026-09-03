import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildManagedModels, DAYBREAK_BLUE_ALIAS } from "./models.ts";

const sol: Model<Api> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	contextWindow: 272_000,
	maxTokens: 128_000,
};

test("managed models apply settings and preserve provider metadata", () => {
	const enabled = buildManagedModels([sol], { longContext: true, daybreak: true });
	assert.equal(enabled.find((model) => model.id === sol.id)?.contextWindow, 1_050_000);
	const blue = enabled.find((model) => model.id === DAYBREAK_BLUE_ALIAS);
	assert.equal(blue?.provider, "openai-codex");
	assert.equal(blue?.api, "openai-codex-responses");

	const standard = buildManagedModels([sol], { longContext: false, daybreak: false });
	assert.equal(standard.find((model) => model.id === sol.id)?.contextWindow, 272_000);
	assert.equal(
		standard.some((model) => model.id === DAYBREAK_BLUE_ALIAS),
		false,
	);
});
