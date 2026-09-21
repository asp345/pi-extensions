import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { delegationPrompt } from "./delegation.ts";
import { resolveModel, resolveThinking } from "./models.ts";
import type { RpcProcess } from "./rpc.ts";
import { finalError, lastAssistantText } from "./transcript.ts";

const { driveRun } = await import("./runner.ts");

const callbacks = {
	onSession: () => undefined,
	onMessages: () => undefined,
	onText: () => undefined,
	onTurn: () => undefined,
	onTool: () => undefined,
	onReport: () => undefined,
};

function fakeProc(overrides: Partial<RpcProcess> = {}): RpcProcess {
	return {
		closed: false,
		onEvent: () => () => undefined,
		prompt: async () => undefined,
		steer: async () => undefined,
		followUp: async () => undefined,
		abort: async () => undefined,
		waitForIdle: async () => undefined,
		getMessages: async () => [],
		getLastAssistantText: async () => null,
		getState: async () => ({}),
		setModel: async (provider: string, modelId: string) => ({ provider, id: modelId }),
		setThinkingLevel: async () => undefined,
		setSessionName: async () => undefined,
		stop: async () => undefined,
		...overrides,
	};
}

test("delegations carry the task and an explicit handoff instead of parent conversation inheritance", () => {
	const prompt = delegationPrompt(
		"Update parser",
		"Act as an implementer. Update the parser and run its focused test.",
		"Parser: src/parser.ts. Preserve public behavior outside issue #42.",
		"/workspace/project",
	);
	assert.match(prompt, /Working directory: \/workspace\/project/u);
	assert.match(prompt, /parent conversation is not inherited/u);
	assert.match(prompt, /## Task\nTitle: Update parser\nAct as an implementer\./u);
	assert.match(prompt, /## Context from parent\nParser: src\/parser\.ts/u);
});

test("the parent model and thinking level are inherited unless overridden", () => {
	const parent = { provider: "test", id: "parent" } as Model<Api>;
	const ctx = { model: parent, thinkingLevel: "xhigh" } as unknown as ExtensionContext;
	assert.equal(resolveModel(undefined, ctx), parent);
	assert.equal(resolveModel("parent", ctx), parent);
	assert.equal(resolveThinking(undefined, ctx), "xhigh");
	assert.equal(resolveThinking("low", ctx), "low");
});

test("an unavailable model override is rejected", () => {
	const ctx = {
		model: { provider: "test", id: "parent" },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
	} as unknown as ExtensionContext;
	assert.throws(() => resolveModel("vendor/missing", ctx), /vendor\/missing is unavailable/u);
});

test("assistant text and errors are read from cached RPC messages", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" },
	] as never;
	assert.equal(lastAssistantText(messages), "answer");
	assert.equal(finalError(messages), undefined);
	const failed = [{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }] as never;
	assert.equal(lastAssistantText(failed), "");
	assert.equal(finalError(failed), "rate limited");
});

test("a provider error in the child transcript is reported as the run error", async () => {
	const messages: Array<Record<string, unknown>> = [];
	const proc = fakeProc({
		async prompt() {
			messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" });
		},
		async getMessages() {
			return messages as never;
		},
	});
	const result = await driveRun(proc, "task", { callbacks });
	assert.equal(result.text, "");
	assert.equal(result.error, "rate limited");
	assert.equal(result.aborted, false);
});

test("report_to_parent tool calls reach the parent as progress reports", async () => {
	const reports: string[] = [];
	let tools = 0;
	const proc = fakeProc({
		onEvent: (listener: (event: Record<string, unknown>) => void) => {
			listener({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "report_to_parent",
				args: { summary: "half done" },
			});
			listener({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "report_to_parent",
				result: {},
				isError: false,
			});
			return () => undefined;
		},
	});
	const result = await driveRun(proc, "task", {
		callbacks: {
			...callbacks,
			onReport: (summary) => reports.push(summary),
			onTool: () => {
				tools += 1;
			},
		},
	});
	assert.deepEqual(reports, ["half done"]);
	assert.equal(tools, 1);
	assert.equal(result.text, "");
});

test("an aborted run reports no error", async () => {
	const controller = new AbortController();
	const proc = fakeProc({
		async prompt() {
			controller.abort();
		},
	});
	const result = await driveRun(proc, "task", { callbacks, signal: controller.signal });
	assert.equal(result.text, "");
	assert.equal(result.aborted, true);
	assert.equal(result.error, undefined);
});
