import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyTierToPayload, tierCostMultiplier } from "./index.ts";

const model: Model<"openai-completions"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 128_000,
	maxTokens: 32_000,
};

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 1,
			cacheWrite: 1,
			totalTokens: 4,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("applyTierToPayload omits service_tier for default and sets exact wire values", () => {
	const payload = { model: "gpt-5.4", stream: true };
	assert.equal(applyTierToPayload(payload, "default"), undefined);
	assert.deepEqual(applyTierToPayload(payload, "flex"), { model: "gpt-5.4", stream: true, service_tier: "flex" });
	assert.deepEqual(applyTierToPayload(payload, "priority"), {
		model: "gpt-5.4",
		stream: true,
		service_tier: "priority",
	});
	assert.equal(tierCostMultiplier("default", "gpt-5.4"), 1);
	assert.equal(tierCostMultiplier("flex", "gpt-5.4"), 0.5);
	assert.equal(tierCostMultiplier("priority", "gpt-5.4"), 2);
	assert.equal(tierCostMultiplier("priority", "gpt-5.5"), 2.5);
});

test("OpenAI requests apply the selected tier and matching cost multiplier", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-service-tier-"));
	t.after(async () => {
		await rm(agentDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;

	let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let command: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let registered: Provider | undefined;
	let lastPayload: unknown;
	let lastServiceTier: string | undefined;

	const base = {
		id: "openai",
		name: "OpenAI",
		getModels: () => [model],
		stream: (_model: Model<Api>, _context: Context, options?: StreamOptions) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				lastServiceTier = (options as { serviceTier?: string } | undefined)?.serviceTier;
				lastPayload = (await options?.onPayload?.({ model: model.id, stream: true }, model)) ?? {
					model: model.id,
					stream: true,
				};
				const result = message();
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			})();
			return stream;
		},
		streamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				lastServiceTier = (options as { serviceTier?: string } | undefined)?.serviceTier;
				lastPayload = (await options?.onPayload?.({ model: model.id, stream: true }, model)) ?? {
					model: model.id,
					stream: true,
				};
				const result = message();
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			})();
			return stream;
		},
	} as unknown as Provider;

	const pi = {
		on(event: string, handler: typeof sessionStart) {
			if (event === "session_start") sessionStart = handler;
		},
		registerProvider(provider: Provider) {
			registered = provider;
		},
		registerCommand(_name: string, config: { handler: typeof command }) {
			command = config.handler;
		},
	} as unknown as ExtensionAPI;

	const { default: serviceTier } = await import(`./index.ts?t=${Date.now()}`);
	await serviceTier(pi);
	assert.ok(sessionStart && command);

	const ctx = {
		hasUI: false,
		ui: { notify() {} },
		modelRegistry: { getProvider: () => base },
	} as unknown as ExtensionContext;

	sessionStart!({}, ctx);
	assert.ok(registered);

	// 1. default tier: no service_tier payload or options.serviceTier
	await command!("default", ctx);
	const defaultResult = await registered.streamSimple(model, { messages: [] }).result();
	assert.deepEqual(lastPayload, { model: model.id, stream: true });
	assert.equal(lastServiceTier, undefined);
	assert.deepEqual(defaultResult.usage.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });

	// 2. flex tier: service_tier: "flex", multiplier 0.5
	await command!("flex", ctx);
	const flexResult = await registered.streamSimple(model, { messages: [] }).result();
	assert.deepEqual(lastPayload, { model: model.id, stream: true, service_tier: "flex" });
	assert.equal(lastServiceTier, "flex");
	assert.deepEqual(flexResult.usage.cost, { input: 0.5, output: 1, cacheRead: 1.5, cacheWrite: 2, total: 5 });
});
