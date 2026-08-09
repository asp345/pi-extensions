import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai";
import openrouterMetadata, {
	fileMetadataCache,
	mergeOpenRouterModels,
	type OpenRouterMetadataCacheEntry,
	readPiOpenRouterModels,
	reportOpenRouterRefreshFailure,
} from "./index.ts";

const bundled: Model<"openai-completions"> = {
	id: "moonshotai/kimi-k3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100,
	maxTokens: 20,
	compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
};

test("extension wraps the live native provider so runtime catalog and models.json composition survive", async () => {
	const registrations: unknown[][] = [];
	let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
	const runtimeOnly = { ...bundled, id: "runtime-only" };
	const base = {
		id: "openrouter",
		name: "OpenRouter",
		getModels: () => [bundled, runtimeOnly],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	} as unknown as Provider<"openai-completions">;
	const pi = {
		registerProvider: (...args: unknown[]) => registrations.push(args),
		on: (event: string, handler: typeof sessionStart) => {
			if (event === "session_start") sessionStart = handler;
		},
	} as unknown as Parameters<typeof openrouterMetadata>[0];
	openrouterMetadata(pi);
	assert.equal(registrations.length, 0);
	sessionStart?.(
		{},
		{
			modelRegistry: {
				getProvider: () => base,
				refresh: async () => undefined,
				find: () => undefined,
			},
			ui: { notify: () => undefined },
		},
	);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0]?.length, 1);
	const registered = registrations[0]?.[0] as Provider<"openai-completions">;
	assert.equal(registered.id, "openrouter");
	assert.ok(registered.getModels().some((model) => model.id === runtimeOnly.id));
	await Promise.resolve();
});

test("refresh failure reporting tolerates stale extension contexts", () => {
	const messages: string[] = [];
	reportOpenRouterRefreshFailure(new Error("network failed"), (message) => messages.push(message));
	assert.deepEqual(messages, ["OpenRouter metadata refresh failed: network failed"]);

	reportOpenRouterRefreshFailure(
		new Error("This extension ctx is stale after session replacement or reload."),
		(message) => messages.push(message),
	);
	assert.equal(messages.length, 1);
	assert.doesNotThrow(() =>
		reportOpenRouterRefreshFailure(new Error("network failed"), () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		}),
	);
});

test("live metadata overlays runtime fields while preserving bundled compatibility", () => {
	const [model] = mergeOpenRouterModels([bundled], {
		data: [
			{
				id: bundled.id,
				name: "MoonshotAI: Kimi K3",
				context_length: 1_048_576,
				architecture: { input_modalities: ["text", "image", "audio"] },
				pricing: {
					prompt: "0.000003",
					completion: "0.000015",
					input_cache_read: "0.0000003",
				},
				top_provider: { max_completion_tokens: 131_072 },
				supported_parameters: ["reasoning", "reasoning_effort"],
				reasoning: {
					mandatory: false,
					supported_efforts: ["max", "high", "low"],
				},
			},
		],
	});
	assert.ok(model);
	assert.equal(model.name, "MoonshotAI: Kimi K3");
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(model.maxTokens, 131_072);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
	assert.deepEqual(model.thinkingLevelMap, {
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	assert.deepEqual(model.compat, bundled.compat);
});

test("mandatory reasoning hides off and unsupported effort levels", () => {
	const [model] = mergeOpenRouterModels([bundled], {
		data: [{ id: bundled.id, reasoning: { mandatory: true, supported_efforts: ["high"] } }],
	});
	assert.deepEqual(model?.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("file cache writes atomically and validates its stored schema", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-openrouter-metadata-"));
	const path = join(directory, "store.json");
	try {
		const cache = fileMetadataCache(path);
		const entry: OpenRouterMetadataCacheEntry = {
			version: 1,
			models: [{ id: bundled.id, contextWindow: 1234, cost: { input: 3 } }],
			checkedAt: Date.now(),
		};
		const newer = { ...entry, models: [{ id: bundled.id, contextWindow: 5678 }], checkedAt: entry.checkedAt + 1 };
		await Promise.all([cache.write(entry), cache.write(newer)]);
		assert.deepEqual(await cache.read(), newer);
		assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
		assert.deepEqual(await readdir(directory), ["store.json"]);
		await writeFile(path, JSON.stringify({ ...newer, version: 2 }));
		assert.equal(await cache.read(), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unknown remote models are not added and invalid catalogs fail closed", () => {
	const models = mergeOpenRouterModels([bundled], {
		data: [{ id: "unknown/new-model", context_length: 999 }],
	});
	assert.equal(models.length, 1);
	assert.equal(models[0]?.id, bundled.id);
	assert.throws(() => mergeOpenRouterModels([bundled], { data: [] }), /empty catalog/u);
	assert.throws(() => mergeOpenRouterModels([bundled], {}), /invalid catalog/u);
});

test("variable-pricing sentinels are preserved so the override keeps auto-router models", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-openrouter-store-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(
			join(directory, "models-store.json"),
			JSON.stringify({
				openrouter: {
					models: [
						{
							...bundled,
							id: "openrouter/auto",
							cost: { input: -1000000, output: -1000000, cacheRead: 0, cacheWrite: 0 },
						},
						{ ...bundled, id: "vendor/priced" },
						{ ...bundled, id: "vendor/broken", cost: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 } },
					],
				},
			}),
		);

		const models = readPiOpenRouterModels();
		assert.deepEqual(
			models.map((model) => model.id),
			["openrouter/auto", "vendor/priced"],
		);
		assert.equal(models[0]?.cost.input, -1000000);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
