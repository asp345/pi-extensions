import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelsStoreEntry, OpenAICompletionsCompat, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createProviderRegistrar, toProviderModel } from "./runtime.ts";
import type { CustomModelConfig, CustomProviderConfig } from "./types.ts";

function recordingPi() {
	const registered: string[] = [];
	const unregistered: string[] = [];
	const configs = new Map<string, ProviderConfig>();
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => {
			registered.push(name);
			configs.set(name, config);
		},
		unregisterProvider: (name: string) => unregistered.push(name),
	} as unknown as ExtensionAPI;
	return { pi, registered, unregistered, configs };
}

function memoryStore(initial?: ModelsStoreEntry) {
	let entry: ModelsStoreEntry | undefined = initial;
	return {
		read: async () => entry,
		write: async (value: ModelsStoreEntry) => {
			entry = value;
		},
		delete: async () => {
			entry = undefined;
		},
		current: () => entry,
	};
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		credential: undefined,
		store: memoryStore(),
		allowNetwork: true,
		...overrides,
	} as RefreshModelsContext;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setImmediate(resolve));
	}
}

test("a configured thinking map reaches pi untouched", () => {
	const model: CustomModelConfig = { id: "vendor/model", reasoning: true, thinkingLevelMap: { max: "max" } };
	assert.deepEqual(toProviderModel(model).thinkingLevelMap, { max: "max" });
});

test("configured models become complete Pi model definitions", () => {
	assert.deepEqual(toProviderModel({ id: "vendor/model" }), {
		id: "vendor/model",
		name: "vendor/model",
		reasoning: false,
		thinkingLevelMap: undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		headers: undefined,
		compat: { supportsDeveloperRole: false },
	});
});

test("the system role is the default, and an explicit setting still wins", () => {
	const developerRole = (model: CustomModelConfig, provider?: CustomProviderConfig["compat"]) =>
		(toProviderModel(model, provider)?.compat as OpenAICompletionsCompat | undefined)?.supportsDeveloperRole;

	assert.equal(developerRole({ id: "a" }), false);
	assert.equal(developerRole({ id: "a" }, { supportsDeveloperRole: true }), true);
	assert.equal(developerRole({ id: "a" }, { supportsDeveloperRole: undefined }), false);
	assert.equal(
		developerRole({ id: "a", compat: { supportsDeveloperRole: true } }, { supportsDeveloperRole: false }),
		true,
	);
});

test("provider compatibility overrides reach every model, and model entries win", () => {
	const { pi, configs } = recordingPi();
	createProviderRegistrar(pi)({
		providers: {
			novita: {
				baseUrl: "https://api.novita.ai/openai",
				api: "openai-completions",
				compat: { supportsDeveloperRole: true, maxTokensField: "max_tokens" },
				models: [{ id: "a" }, { id: "b", compat: { maxTokensField: "max_completion_tokens" } }],
			},
		},
	});
	const models = configs.get("novita")?.models;
	assert.deepEqual(models?.[0]?.compat, { supportsDeveloperRole: true, maxTokensField: "max_tokens" });
	assert.deepEqual(models?.[1]?.compat, { supportsDeveloperRole: true, maxTokensField: "max_completion_tokens" });
});

test("only complete custom providers are registered, and built-ins are never replaced", () => {
	const { pi, registered } = recordingPi();
	createProviderRegistrar(pi)({
		providers: {
			novita: { baseUrl: "https://api.novita.ai/openai", api: "openai-completions", models: [{ id: "a" }] },
			incomplete: { models: [{ id: "b" }] },
			openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", models: [{ id: "c" }] },
		},
	});
	assert.deepEqual(registered, ["novita"]);
});

test("providers removed from the file are unregistered", () => {
	const { pi, registered, unregistered } = recordingPi();
	const provider = { baseUrl: "https://example.com/v1", api: "openai-completions" as const, models: [{ id: "a" }] };
	const registerProviders = createProviderRegistrar(pi);

	registerProviders({ providers: { temp: provider } });
	registerProviders({ providers: {} });

	assert.deepEqual(registered, ["temp"]);
	assert.deepEqual(unregistered, ["temp"]);
});

test("refreshes stay offline-safe, throttled, and non-destructive", async () => {
	const { pi, configs } = recordingPi();
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		calls += 1;
		if (String(input).includes("openrouter.ai")) return new Response("unavailable", { status: 503 });
		return new Response(JSON.stringify({ data: [{ id: "a", context_length: 262_144 }] }), { status: 200 });
	}) as typeof fetch;

	try {
		createProviderRegistrar(pi)({
			providers: {
				vendor: {
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
					models: [{ id: "a", contextWindow: 4096 }],
				},
			},
		});
		const refresh = configs.get("vendor")?.refreshModels;
		if (!refresh) throw new Error("expected a refreshable provider");

		const offline = await refresh(refreshContext({ allowNetwork: false }));
		assert.equal(calls, 0);
		assert.equal(offline[0]?.contextWindow, 4096);

		// a forced refresh discovers and returns the networked catalog
		assert.equal((await refresh(refreshContext({ force: true })))[0]?.contextWindow, 262_144);
		const afterFirst = calls;
		// implicit refreshes within the TTL reuse the cached catalog without a request
		assert.equal((await refresh(refreshContext()))[0]?.contextWindow, 262_144);
		assert.equal(calls, afterFirst);

		globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
		assert.equal((await refresh(refreshContext({ force: true })))[0]?.contextWindow, 262_144);
	} finally {
		globalThis.fetch = original;
	}
});

test("a networked refresh persists the catalog for later offline sessions", async () => {
	const provider = {
		baseUrl: "https://example.com/v1",
		api: "openai-completions" as const,
		models: [{ id: "a", contextWindow: 4096 }],
	};
	const store = memoryStore();
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) =>
		String(input).includes("openrouter.ai")
			? new Response("unavailable", { status: 503 })
			: new Response(JSON.stringify({ data: [{ id: "a", context_length: 262_144, features: ["reasoning"] }] }), {
					status: 200,
				})) as typeof fetch;

	try {
		const online = recordingPi();
		createProviderRegistrar(online.pi)({ providers: { vendor: provider } });
		await online.configs.get("vendor")?.refreshModels?.(refreshContext({ store, force: true }));

		const restarted = recordingPi();
		createProviderRegistrar(restarted.pi)({ providers: { vendor: provider } });
		const offline = await restarted.configs
			.get("vendor")
			?.refreshModels?.(refreshContext({ store, allowNetwork: false }));

		assert.equal(offline?.[0]?.contextWindow, 262_144);
		assert.equal(offline?.[0]?.reasoning, true);
	} finally {
		globalThis.fetch = original;
	}
});

test("a fresh persisted catalog is reused across restarts without a network request", async () => {
	const provider = {
		baseUrl: "https://example.com/v1",
		api: "openai-completions" as const,
		models: [{ id: "a", contextWindow: 4096 }],
	};
	const store = memoryStore();
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		calls += 1;
		if (String(input).includes("openrouter.ai")) return new Response("unavailable", { status: 503 });
		return new Response(JSON.stringify({ data: [{ id: "a", context_length: 262_144 }] }), { status: 200 });
	}) as typeof fetch;

	try {
		const first = recordingPi();
		createProviderRegistrar(first.pi)({ providers: { vendor: provider } });
		const networked = await first.configs.get("vendor")?.refreshModels?.(refreshContext({ store, force: true }));
		assert.equal(networked?.[0]?.contextWindow, 262_144);
		assert.ok((store.current()?.checkedAt ?? 0) > 0);

		const restarted = recordingPi();
		createProviderRegistrar(restarted.pi)({ providers: { vendor: provider } });
		const callsBefore = calls;
		const fresh = await restarted.configs.get("vendor")?.refreshModels?.(refreshContext({ store }));
		assert.equal(fresh?.[0]?.contextWindow, 262_144);
		assert.equal(calls, callsBefore);
	} finally {
		globalThis.fetch = original;
	}
});

test("an implicit refresh enriches the catalog in the background without blocking", async () => {
	const provider = {
		baseUrl: "https://example.com/v1",
		api: "openai-completions" as const,
		models: [{ id: "a", contextWindow: 4096 }],
	};
	const store = memoryStore();
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		calls += 1;
		if (String(input).includes("openrouter.ai")) return new Response("unavailable", { status: 503 });
		return new Response(JSON.stringify({ data: [{ id: "a", context_length: 262_144 }] }), { status: 200 });
	}) as typeof fetch;

	try {
		const { pi, configs } = recordingPi();
		createProviderRegistrar(pi)({ providers: { vendor: provider } });
		const refresh = configs.get("vendor")?.refreshModels;
		if (!refresh) throw new Error("expected a refreshable provider");

		const immediate = await refresh(refreshContext({ store }));
		assert.equal(immediate[0]?.contextWindow, 4096);
		await waitFor(() => (store.current()?.checkedAt ?? 0) > 0);
		const enriched = await refresh(refreshContext({ store }));
		assert.equal(enriched[0]?.contextWindow, 262_144);
	} finally {
		globalThis.fetch = original;
	}
});

test("a persisted catalog past its maximum age is deleted instead of merged", async () => {
	const provider = {
		baseUrl: "https://example.com/v1",
		api: "openai-completions" as const,
		models: [{ id: "a", contextWindow: 4096, maxTokens: 1024 }],
	};
	const aged = (checkedAt: number | undefined) =>
		memoryStore({
			models: [{ id: "a", contextWindow: 262_144 } as unknown as ModelsStoreEntry["models"][number]],
			checkedAt,
		});
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("offline", { status: 503 })) as typeof fetch;

	try {
		const fresh = aged(Date.now() - 60_000);
		const recent = recordingPi();
		createProviderRegistrar(recent.pi)({ providers: { vendor: provider } });
		const kept = await recent.configs
			.get("vendor")
			?.refreshModels?.(refreshContext({ store: fresh, allowNetwork: false }));
		assert.equal(kept?.[0]?.contextWindow, 262_144);
		assert.notEqual(fresh.current(), undefined);

		for (const store of [aged(Date.now() - 31 * 24 * 60 * 60_000), aged(undefined)]) {
			const expired = recordingPi();
			createProviderRegistrar(expired.pi)({ providers: { vendor: provider } });
			const models = await expired.configs
				.get("vendor")
				?.refreshModels?.(refreshContext({ store, allowNetwork: false }));
			assert.equal(models?.[0]?.contextWindow, 4096);
			assert.equal(store.current(), undefined);
		}
	} finally {
		globalThis.fetch = original;
	}
});
