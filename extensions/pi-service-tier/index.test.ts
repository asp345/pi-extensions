import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler } from "@earendil-works/pi-coding-agent";

test("openai requests get service_tier when a non-default tier is selected", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-service-tier-"));
	t.after(async () => {
		await rm(agentDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;

	let handler: ExtensionHandler<{ type: "before_provider_request"; payload: unknown }, unknown> | undefined;
	let command: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	const pi = {
		on(_event: string, next: typeof handler) {
			handler = next;
		},
		registerCommand(_name: string, config: { handler: typeof command }) {
			command = config.handler;
		},
	} as unknown as ExtensionAPI;

	const { default: serviceTier } = await import(`./index.ts?t=${Date.now()}`);
	await serviceTier(pi);
	assert.ok(handler && command);

	const ctx = {
		hasUI: false,
		model: { provider: "openai" },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const payload = { model: "gpt-5", stream: true };

	assert.equal(await handler!({ type: "before_provider_request", payload }, ctx), undefined);
	await command!("flex", ctx);
	assert.deepEqual(await handler!({ type: "before_provider_request", payload }, ctx), {
		...payload,
		service_tier: "flex",
	});
	assert.equal(
		await handler!(
			{ type: "before_provider_request", payload },
			{ ...ctx, model: { provider: "anthropic" } } as unknown as ExtensionContext,
		),
		undefined,
	);
});
