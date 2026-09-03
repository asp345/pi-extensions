import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createProviderRegistrar, toProviderModel } from "./runtime.ts";
import type { CustomModelConfig, CustomProviderConfig } from "./types.ts";

function recordingPi() {
	const registered: string[] = [];
	const unregistered: string[] = [];
	const pi = {
		registerProvider: (name: string, _config: ProviderConfig) => {
			registered.push(name);
		},
		unregisterProvider: (name: string) => unregistered.push(name),
	} as unknown as ExtensionAPI;
	return { pi, registered, unregistered };
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

test("only complete custom providers are registered, and built-ins are never replaced", () => {
	const { pi, registered } = recordingPi();
	createProviderRegistrar(pi)({
		providers: {
			novita: { baseUrl: "https://api.novita.ai/openai", api: "openai-completions" },
			incomplete: {},
			openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
		},
	});
	assert.deepEqual(registered, ["novita"]);
});

test("providers removed from the file are unregistered", () => {
	const { pi, registered, unregistered } = recordingPi();
	const provider = { baseUrl: "https://example.com/v1", api: "openai-completions" as const };
	const registerProviders = createProviderRegistrar(pi);

	registerProviders({ providers: { temp: provider } });
	registerProviders({ providers: {} });

	assert.deepEqual(registered, ["temp"]);
	assert.deepEqual(unregistered, ["temp"]);
});
