import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import openrouterMetadata, {
	createOpenRouterMetadataProvider,
	fileMetadataCache,
	mergeOpenRouterModels,
	type OpenRouterMetadataCache,
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

const store = {
	read: async (): Promise<ModelsStoreEntry | undefined> => undefined,
	write: async (_entry: ModelsStoreEntry) => undefined,
	delete: async () => undefined,
};

const livePayload = {
	data: [
		{
			id: bundled.id,
			reasoning: { mandatory: false, supported_efforts: ["low", "high", "max"] },
		},
	],
};

interface InspectableMemoryCache extends OpenRouterMetadataCache {
	current(): OpenRouterMetadataCacheEntry | undefined;
}

function memoryCache(initial?: OpenRouterMetadataCacheEntry): InspectableMemoryCache {
	let entry = initial;
	return {
		read: async () => structuredClone(entry),
		write: async (value) => {
			entry = structuredClone(value);
		},
		current: () => structuredClone(entry),
	};
}

async function testProvider(fetcher: typeof fetch, cache = memoryCache(), initialCache?: OpenRouterMetadataCacheEntry) {
	const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
	return createOpenRouterMetadataProvider(openrouterProvider(), fetcher, cache, initialCache);
}

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

test("provider refresh caches successful metadata in memory and force bypasses the TTL", async () => {
	let calls = 0;
	const provider = await testProvider(async () => {
		calls += 1;
		return new Response(JSON.stringify(livePayload), { status: 200 });
	});
	const refresh = provider.refreshModels;
	if (!refresh) throw new Error("Expected refreshable provider.");
	const context = { credential: { type: "api_key" as const, key: "test" }, store, allowNetwork: true };
	await refresh(context);
	await refresh(context);
	assert.equal(calls, 1);
	assert.equal(provider.getModels().find((model) => model.id === bundled.id)?.thinkingLevelMap?.max, "max");
	await refresh({ ...context, force: true });
	assert.equal(calls, 2);
});

test("offline refresh does not issue a request", async () => {
	let calls = 0;
	const provider = await testProvider(async () => {
		calls += 1;
		return new Response(JSON.stringify(livePayload), { status: 200 });
	});
	await provider.refreshModels?.({
		credential: { type: "api_key", key: "test" },
		store,
		allowNetwork: false,
	});
	assert.equal(calls, 0);
});

test("base catalog refreshes survive while live metadata remains overlaid", async () => {
	const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
	const raw = openrouterProvider();
	let refreshes = 0;
	let baseModels: Model<"openai-completions">[] = [bundled];
	const added: Model<"openai-completions"> = {
		...bundled,
		id: "vendor/new-model",
		name: "New model",
	};
	const base = {
		...raw,
		getModels: () => baseModels,
		refreshModels: async () => {
			refreshes += 1;
			baseModels = [{ ...bundled, name: "pi.dev name", contextWindow: 900 + refreshes }, added];
		},
	};
	const provider = createOpenRouterMetadataProvider(
		base,
		async () => new Response(JSON.stringify(livePayload), { status: 200 }),
		memoryCache(),
	);
	const refresh = provider.refreshModels;
	if (!refresh) throw new Error("Expected refreshable provider.");
	const context = { credential: { type: "api_key" as const, key: "test" }, store, allowNetwork: true };
	await refresh(context);
	await refresh({ ...context, allowNetwork: false });
	const current = provider.getModels().find((model) => model.id === bundled.id);
	assert.equal(current?.name, "pi.dev name");
	assert.equal(current?.contextWindow, 902);
	assert.equal(current?.thinkingLevelMap?.max, "max");
	assert.equal(
		provider.getModels().some((model) => model.id === added.id),
		true,
	);
});

test("persistent cache restores metadata offline and revalidates with its ETag", async () => {
	const cached: OpenRouterMetadataCacheEntry = {
		version: 1,
		models: [
			{
				id: bundled.id,
				reasoning: true,
				thinkingLevelMap: {
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
			},
		],
		checkedAt: Date.now(),
		etag: 'W/"cached"',
		lastModified: "Mon, 27 Jul 2026 00:00:00 GMT",
	};
	const requests: Request[] = [];
	const cache = memoryCache(cached);
	const provider = await testProvider(
		async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(null, { status: 304 });
		},
		cache,
		cached,
	);
	assert.equal(provider.getModels().find((model) => model.id === bundled.id)?.thinkingLevelMap?.max, "max");
	const refresh = provider.refreshModels;
	if (!refresh) throw new Error("Expected refreshable provider.");
	const context = { credential: { type: "api_key" as const, key: "test" }, store, allowNetwork: false };
	await refresh(context);
	assert.equal(provider.getModels().find((model) => model.id === bundled.id)?.thinkingLevelMap?.max, "max");
	await refresh({ ...context, allowNetwork: true, force: true });
	assert.equal(requests[0]?.headers.get("if-none-match"), 'W/"cached"');
	assert.equal(requests[0]?.headers.get("if-modified-since"), "Mon, 27 Jul 2026 00:00:00 GMT");
});

test("an empty cached overlay still uses validators and accepts 304", async () => {
	const cache = memoryCache({
		version: 1,
		models: [],
		checkedAt: 1,
		etag: 'W/"empty"',
	});
	let request: Request | undefined;
	const provider = await testProvider(async (input, init) => {
		request = new Request(input, init);
		return new Response(null, { status: 304 });
	}, cache);
	await provider.refreshModels?.({
		credential: { type: "api_key", key: "test" },
		store,
		allowNetwork: true,
		force: true,
	});
	assert.equal(request?.headers.get("if-none-match"), 'W/"empty"');
	assert.ok((cache.current()?.checkedAt ?? 0) > 1);
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

test("refresh failures retain the last successful model overlay", async () => {
	let fail = false;
	const provider = await testProvider(async () => {
		if (fail) throw new Error("network failed");
		return new Response(JSON.stringify(livePayload), { status: 200 });
	});
	const refresh = provider.refreshModels;
	if (!refresh) throw new Error("Expected refreshable provider.");
	const context = { credential: { type: "api_key" as const, key: "test" }, store, allowNetwork: true };
	await refresh(context);
	assert.equal(provider.getModels().find((model) => model.id === bundled.id)?.thinkingLevelMap?.max, "max");
	fail = true;
	await assert.rejects(refresh({ ...context, force: true }), /network failed/u);
	assert.equal(provider.getModels().find((model) => model.id === bundled.id)?.thinkingLevelMap?.max, "max");
});

test("HTTP failures retain cached freshness instead of suppressing retries", async () => {
	const cached: OpenRouterMetadataCacheEntry = {
		version: 1,
		models: [{ id: bundled.id, reasoning: true }],
		checkedAt: 1,
	};
	const cache = memoryCache(cached);
	const provider = await testProvider(async () => new Response("unavailable", { status: 503 }), cache);
	const refresh = provider.refreshModels;
	if (!refresh) throw new Error("Expected refreshable provider.");
	await assert.rejects(
		refresh({
			credential: { type: "api_key", key: "test" },
			store,
			allowNetwork: true,
			force: true,
		}),
		/HTTP 503/u,
	);
	assert.equal(cache.current()?.checkedAt, 1);
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
