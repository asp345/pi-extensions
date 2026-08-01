import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
			try {
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			} catch {
				return nextResolve(specifier, context);
			}
		}
		return nextResolve(specifier, context);
	},
});

const { parseDefinition } = await import("./definitions.ts");
const { promptWithFallbacks, resolveModel, resolveThinking, resumeSession, turnLimitAction } = await import(
	"./runner.ts"
);

test("agent Markdown accepts ordered models", () => {
	const path = fileURLToPath(new URL("./agents/General.md", import.meta.url));
	const definition = parseDefinition(path, "default");
	assert.deepEqual(definition.models, ["parent", "anthropic/claude-opus-5", "openai/gpt-5.6-terra"]);
	assert.equal(definition.thinking, "parent");

	const explore = parseDefinition(fileURLToPath(new URL("./agents/Explore.md", import.meta.url)), "default");
	assert.deepEqual(explore.models, ["openai-codex/gpt-5.6-luna", "openrouter/deepseek/deepseek-v4-flash-0731"]);

	const plan = parseDefinition(fileURLToPath(new URL("./agents/Plan.md", import.meta.url)), "default");
	assert.ok(plan.tools.includes("web_search"));
	assert.ok(plan.tools.includes("fetch_content"));

	const review = parseDefinition(fileURLToPath(new URL("./agents/Review.md", import.meta.url)), "default");
	assert.ok(!review.tools.includes("edit"));
	assert.ok(!review.tools.includes("write"));
	assert.equal(review.thinking, "xhigh");
});

test("the parent model can be selected explicitly", () => {
	const parent = { provider: "test", id: "parent" } as Model<Api>;
	const ctx = { model: parent, thinkingLevel: "xhigh" } as unknown as ExtensionContext;
	assert.equal(resolveModel("parent", ctx), parent);
	assert.equal(resolveModel(undefined, ctx), parent);
	assert.equal(resolveThinking("parent", ctx), "xhigh");
	assert.equal(resolveThinking("low", ctx), "low");
});

const callbacks = {
	onSession: () => undefined,
	onFallback: () => undefined,
	onText: () => undefined,
	onTurn: () => undefined,
	onTool: () => undefined,
};

test("a failed model tries later models until one succeeds", async () => {
	const primary = { provider: "primary", id: "model" } as Model<Api>;
	const unavailable = { provider: "backup", id: "unavailable" } as Model<Api>;
	const backup = { provider: "backup", id: "model" } as Model<Api>;
	const prompts: string[] = [];
	const fallbacks: string[] = [];
	const fake = {
		messages: [] as Array<Record<string, unknown>>,
		model: primary,
		async setModel(model: Model<Api>) {
			if (model === unavailable) throw new Error("unavailable");
			this.model = model;
		},
		async prompt(prompt: string) {
			prompts.push(prompt);
			if (prompts.length === 1) {
				this.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" });
			} else {
				this.messages.push({
					role: "assistant",
					content: [{ type: "text", text: "backup-ok" }],
					stopReason: "stop",
				});
			}
		},
	};
	const result = await promptWithFallbacks(fake as unknown as AgentSession, "original task", 0, {
		models: () => [primary, unavailable, backup],
		callbacks: {
			...callbacks,
			onFallback: (model, reason) => fallbacks.push(`${model.provider}/${model.id}: ${reason}`),
		},
	});
	assert.deepEqual(result, { text: "backup-ok" });
	assert.equal(fake.model, backup);
	assert.equal(prompts[0], "original task");
	assert.match(prompts[1] ?? "", /Continue the original task/u);
	assert.deepEqual(fallbacks, ["backup/model: rate limited"]);
});

test("unavailable optional models are ignored", async () => {
	const primary = { provider: "primary", id: "model" } as Model<Api>;
	const fake = {
		messages: [] as Array<Record<string, unknown>>,
		model: primary,
		async setModel() {
			throw new Error("must not switch");
		},
		async prompt() {
			this.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "primary failed" });
		},
	};
	const result = await promptWithFallbacks(fake as unknown as AgentSession, "task", 0, {
		models: () => {
			throw new Error("models unavailable");
		},
		callbacks,
	});
	assert.deepEqual(result, { text: "", error: "Primary model failed: primary failed" });
});

test("cancellation suppresses turn-limit follow-ups", () => {
	assert.equal(turnLimitAction(2, 2, false, true), undefined);
	assert.equal(turnLimitAction(2, 2, false, false), "warn");
	assert.equal(turnLimitAction(3, 2, true, false), "abort");
});

test("resume keeps using the currently selected fallback model", async () => {
	const backup = { provider: "backup", id: "model" } as Model<Api>;
	let modelChanges = 0;
	const fake = {
		messages: [] as Array<Record<string, unknown>>,
		model: backup,
		subscribe: () => () => undefined,
		async setModel(model: Model<Api>) {
			modelChanges += 1;
			this.model = model;
		},
		async prompt() {
			this.messages.push({
				role: "assistant",
				content: [{ type: "text", text: "resumed-on-backup" }],
				stopReason: "stop",
			});
		},
	};
	const result = await resumeSession(fake as unknown as AgentSession, "continue", {
		models: () => [backup],
		callbacks,
	});
	assert.deepEqual(result, { text: "resumed-on-backup" });
	assert.equal(modelChanges, 0);
	assert.equal(fake.model, backup);
});
