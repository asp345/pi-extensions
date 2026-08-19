import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capabilityTokens,
	discoverProviderModels,
	mergeConfiguredModels,
	modelEndpointCandidates,
	parseModelMetadata,
} from "./discovery.ts";
import type { ModelMetadata } from "./types.ts";

test("Novita listings expose reasoning, context, casing, and per-million pricing", () => {
	const model = parseModelMetadata({
		id: "Sao10K/L3-8B-Stheno-v3.2",
		features: ["serverless", "reasoning", "vision"],
		context_size: 1_048_576,
		max_output_tokens: 65_536,
		pricing: {
			prompt: { origin_price_per_m: 2700, price_per_m: 2700 },
			completion: { origin_price_per_m: 11_200, price_per_m: 11_200 },
			input_cache_read: { price_per_m: 350 },
		},
	});

	assert.equal(model?.id, "Sao10K/L3-8B-Stheno-v3.2");
	assert.equal(model?.reasoning, true);
	assert.deepEqual(model?.input, ["text", "image"]);
	assert.equal(model?.contextWindow, 1_048_576);
	assert.equal(model?.maxTokens, 65_536);
	assert.deepEqual(model?.cost, { input: 0.27, output: 1.12, cacheRead: 0.035, cacheWrite: 0 });
});

test("OpenRouter listings expose reasoning objects, effort levels, and modalities", () => {
	const model = parseModelMetadata({
		id: "vendor/reasoner",
		reasoning: { mandatory: true, supported_efforts: ["low", "high", "max"] },
		architecture: { input_modalities: ["text", "image"] },
		context_length: 262_144,
		top_provider: { max_completion_tokens: 32_768 },
		pricing: { prompt: "0.000003", completion: "0.000015" },
	});

	assert.equal(model?.reasoning, true);
	assert.deepEqual(model?.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	assert.deepEqual(model?.input, ["text", "image"]);
	assert.deepEqual(model?.cost, { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
});

test("free models keep zero pricing and variable-pricing sentinels are ignored", () => {
	const free = parseModelMetadata({ id: "vendor/free", pricing: { prompt: "0", completion: "0" } });
	assert.deepEqual(free?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	const variable = parseModelMetadata({ id: "vendor/auto", pricing: { prompt: "-1", completion: "-1" } });
	assert.equal(variable?.cost, undefined);
});

test("capability tokens normalize provider vocabulary", () => {
	assert.deepEqual(
		capabilityTokens({ features: ["Function-Calling", "VISION"], supported_parameters: ["reasoning"] }),
		new Set(["function_calling", "vision", "reasoning"]),
	);
});

test("Baseten listings declare reasoning through supported_features", () => {
	const model = parseModelMetadata({
		id: "zai-org/GLM-5.2",
		name: "GLM 5.2",
		context_length: 1_048_576,
		max_completion_tokens: 262_144,
		supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
		supported_sampling_parameters: ["temperature", "top_p", "stop"],
		input_modalities: ["text"],
		pricing: { prompt: "0.0000014", completion: "0.0000044", input_cache_read: "0.00000014" },
	});

	assert.equal(model?.reasoning, true);
	assert.equal(model?.thinkingLevelMap, undefined);
	assert.equal(model?.contextWindow, 1_048_576);
	assert.equal(model?.maxTokens, 262_144);
	assert.deepEqual(model?.cost, { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 });
});

test("endpoint candidates respect versioned base URLs and API formats", () => {
	assert.deepEqual(modelEndpointCandidates({ baseUrl: "https://api.novita.ai/openai", api: "openai-completions" }), [
		"https://api.novita.ai/openai/v1/models",
		"https://api.novita.ai/openai/models",
	]);
	assert.deepEqual(modelEndpointCandidates({ baseUrl: "https://example.com/v1/", api: "openai-completions" }), [
		"https://example.com/v1/models",
	]);
	assert.deepEqual(modelEndpointCandidates({ baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }), []);
	assert.deepEqual(
		modelEndpointCandidates({ baseUrl: "https://generativelanguage.googleapis.com", api: "google-generative-ai" }),
		["https://generativelanguage.googleapis.com/v1beta/models"],
	);
});

test("discovery sends resolved credentials and falls through failing endpoints", async () => {
	const requests: Array<{ url: string; authorization: string | null }> = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, authorization: request.headers.get("authorization") });
		if (requests.length === 1) return new Response("nope", { status: 404 });
		return new Response(JSON.stringify({ data: [{ id: "vendor/model", context_length: 1000 }] }), { status: 200 });
	}) as typeof fetch;

	try {
		const models = await discoverProviderModels(
			{ baseUrl: "https://example.com", api: "openai-completions" },
			{ auth: { apiKey: "sk-live" } },
		);
		assert.deepEqual([...models.keys()], ["vendor/model"]);
		assert.deepEqual(
			requests.map((request) => request.url),
			["https://example.com/v1/models", "https://example.com/models"],
		);
		assert.equal(requests[0]?.authorization, "Bearer sk-live");
	} finally {
		globalThis.fetch = original;
	}
});

test("discovery reports every endpoint failure", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("bad", { status: 500 })) as typeof fetch;
	try {
		await assert.rejects(
			discoverProviderModels({ baseUrl: "https://example.com/v1", api: "openai-completions" }),
			/500/u,
		);
	} finally {
		globalThis.fetch = original;
	}
});

function metadata(entries: Record<string, ModelMetadata>): Map<string, ModelMetadata> {
	return new Map(Object.entries(entries));
}

test("the provider listing supplies metadata, and manual limits survive", () => {
	const merged = mergeConfiguredModels(
		[
			{ id: "vendor/model", contextWindow: 8000, maxTokens: 1000, limitSource: "default" },
			{ id: "vendor/manual", contextWindow: 4096, maxTokens: 512, limitSource: "manual" },
		],
		metadata({
			"vendor/model": {
				id: "vendor/model",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262_144,
				maxTokens: 65_536,
			},
			"vendor/manual": { id: "vendor/manual", contextWindow: 262_144 },
		}),
	);

	assert.deepEqual(merged[0], {
		id: "vendor/model",
		name: "vendor/model",
		reasoning: true,
		thinkingLevelMap: undefined,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 65_536,
		limitSource: "detected",
	});
	assert.equal(merged[1]?.contextWindow, 4096);
	assert.equal(merged[1]?.limitSource, "manual");
});

test("a model missing from the listing keeps its configuration untouched", () => {
	const [model] = mergeConfiguredModels(
		[{ id: "vendor/model", reasoning: true, contextWindow: 4096, thinkingLevelMap: { low: "low" } }],
		metadata({}),
	);

	assert.equal(model?.reasoning, true);
	assert.equal(model?.contextWindow, 4096);
	assert.deepEqual(model?.thinkingLevelMap, { low: "low" });
});

test("pricing refreshes even when a stale zero cost was stored", () => {
	const [model] = mergeConfiguredModels(
		[{ id: "vendor/model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		metadata({
			"vendor/model": { id: "vendor/model", cost: { input: 0.27, output: 1.12, cacheRead: 0, cacheWrite: 0 } },
		}),
	);

	assert.deepEqual(model?.cost, { input: 0.27, output: 1.12, cacheRead: 0, cacheWrite: 0 });
});

test("user edits are never overwritten by discovery", () => {
	const [model] = mergeConfiguredModels(
		[{ id: "vendor/model", name: "My name", reasoning: true, thinkingLevelMap: { max: "max" } }],
		metadata({ "vendor/model": { id: "vendor/model", name: "Vendor name", reasoning: false } }),
	);

	assert.equal(model?.name, "My name");
	assert.equal(model?.reasoning, true);
	assert.deepEqual(model?.thinkingLevelMap, { max: "max" });
});
