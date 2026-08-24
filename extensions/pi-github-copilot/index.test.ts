import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { wrapProvider } from "./index.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_000,
};

test("wrapped catalog and credential filtering contain each model ID once", () => {
	const base = {
		id: "github-copilot",
		name: "GitHub Copilot",
		getModels: () => [model],
		filterModels: (models: Model<Api>[]) => models,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	} as unknown as Provider;
	const wrapped = wrapProvider(base, [model.id]);
	const models = wrapped.getModels();
	const filtered = wrapped.filterModels?.(models, undefined) ?? models;
	for (const catalog of [models, filtered]) {
		const ids = catalog.map((entry) => entry.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.deepEqual(ids, ["auto", `auto-${model.id}`, model.id]);
	}
});
