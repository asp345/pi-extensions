import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
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
	let payload: unknown;
	const base = {
		id: "openai",
		name: "OpenAI",
		getModels: () => [model],
		stream: (_model: Model<Api>, _context: Context, options?: StreamOptions) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				payload = (await options?.onPayload?.({ model: model.id, stream: true }, model)) ?? payload;
				const result = message();
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			})();
			return stream;
		},
		streamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				payload = (await options?.onPayload?.({ model: model.id, stream: true }, model)) ?? payload;
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
	await command!("flex", ctx);
	sessionStart!({}, ctx);
	assert.ok(registered);
	const result = await registered.streamSimple(model, { messages: [] }).result();
	assert.deepEqual(payload, { model: model.id, stream: true, service_tier: "flex" });
	assert.deepEqual(result.usage.cost, { input: 0.5, output: 1, cacheRead: 1.5, cacheWrite: 2, total: 5 });
});
