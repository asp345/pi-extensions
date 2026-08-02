import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
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

test("wrapped catalog persists auto models without dropping base validators", async () => {
	let stored: ModelsStoreEntry | undefined = { models: [model], checkedAt: 0, etag: 'W/"old"' };
	let refreshedModels = [model];
	const base = {
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: model.baseUrl,
		getModels: () => refreshedModels,
		refreshModels: async (context: { store: { write(entry: ModelsStoreEntry): Promise<void> } }) => {
			refreshedModels = [{ ...model, name: "Refreshed" }];
			await context.store.write({ models: refreshedModels, checkedAt: 10, etag: 'W/"new"', lastModified: 9 });
		},
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	} as unknown as Provider;
	let resolveRefresh!: () => void;
	const completed = new Promise<void>((resolve) => {
		resolveRefresh = resolve;
	});
	const wrapped = wrapProvider(base, [model.id], resolveRefresh);
	await wrapped.refreshModels?.({
		allowNetwork: true,
		force: true,
		store: {
			read: async () => structuredClone(stored),
			write: async (entry) => {
				stored = structuredClone(entry);
			},
			delete: async () => {
				stored = undefined;
			},
		},
	});
	await completed;

	assert.equal(stored?.etag, 'W/"new"');
	assert.equal(stored?.lastModified, 9);
	assert.ok(stored?.models.some((entry) => entry.id === "auto"));
	assert.ok(stored?.models.some((entry) => entry.id === `auto-${model.id}`));
	assert.ok(stored?.models.some((entry) => entry.id === model.id));
});
