import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcProcess } from "./rpc.ts";

const { AgentManager } = await import("./manager.ts");

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

function newManager(startSession?: unknown) {
	return new AgentManager(
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		startSession as never,
	);
}

test("background subagents are detached from the parent turn abort signal", async () => {
	let childSignal: AbortSignal | undefined;
	const startSession = async (_ctx: ExtensionContext, request: { parentSignal?: AbortSignal }) => {
		childSignal = request.parentSignal;
		return { proc: fakeProc(), text: "done", messages: [] };
	};
	const manager = newManager(startSession);
	const parent = new AbortController();
	parent.abort();
	const record = manager.spawn({ cwd: process.cwd() } as ExtensionContext, "Task title", "task", {
		background: true,
		signal: parent.signal,
	});
	await record.promise;
	assert.equal(childSignal?.aborted, false);
	assert.equal(record.status, "completed");
});

test("stopped subagents retain their ID and process when resumed", async () => {
	let aborted = false;
	const prompts: string[] = [];
	const messages: Array<Record<string, unknown>> = [];
	const proc = fakeProc({
		async abort() {
			aborted = true;
		},
		async prompt(text: string) {
			prompts.push(text);
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "resumed" }],
				stopReason: "stop",
			});
		},
		async getMessages() {
			return messages as never;
		},
	});
	const manager = newManager();
	manager.restore([
		{
			id: "agent-id",
			title: "Task title",
			prompt: "original task",
			cwd: process.cwd(),
			status: "running",
			background: true,
			startedAt: Date.now(),
			turns: 1,
			toolUses: 0,
			messages: [],
			proc,
			abortController: new AbortController(),
			pendingSteers: [],
			promise: Promise.resolve(),
		},
	]);

	assert.equal(manager.stop("agent-id"), true);
	assert.equal(aborted, true);
	assert.equal(manager.get("agent-id")?.status, "stopped");
	assert.equal(manager.get("agent-id")?.resultConsumed, true);

	const resumed = await manager.resume({} as ExtensionContext, "agent-id", {
		title: "Task title",
		background: false,
	});
	assert.equal(resumed.id, "agent-id");
	assert.equal(resumed.status, "completed");
	assert.equal(resumed.result, "resumed");
	assert.deepEqual(prompts, ["Continue the assigned task from where it stopped."]);
	assert.equal(resumed.prompt, "original task");
});

test("a session-less resume starts a new run tracked by the record promise", async () => {
	const prompts: string[] = [];
	const startSession = async (_ctx: ExtensionContext, request: { prompt: string }) => {
		prompts.push(request.prompt);
		return { proc: fakeProc(), text: "done", messages: [] };
	};
	const manager = newManager(startSession);
	manager.restore([
		{
			id: "agent-fresh",
			title: "Task title",
			prompt: "original task",
			cwd: process.cwd(),
			status: "stopped",
			background: true,
			startedAt: Date.now(),
			completedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			messages: [],
			abortController: new AbortController(),
			pendingSteers: [],
		},
	]);

	const before = manager.get("agent-fresh")?.promise;
	const resumed = await manager.resume({ cwd: process.cwd() } as ExtensionContext, "agent-fresh", {
		title: "Task title",
		background: true,
	});
	assert.notEqual(resumed.promise, before);
	await resumed.promise;
	assert.deepEqual(prompts, ["original task"]);
	assert.equal(resumed.status, "completed");
});

test("user-initiated stops keep the completion notification consumable", () => {
	const manager = newManager();
	manager.restore([
		{
			id: "agent-ui-stop",
			title: "Task title",
			prompt: "task",
			cwd: process.cwd(),
			status: "running",
			background: true,
			startedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			messages: [],
			abortController: new AbortController(),
			pendingSteers: [],
			promise: Promise.resolve(),
		},
	]);

	assert.equal(manager.stop("agent-ui-stop", false), true);
	assert.equal(manager.get("agent-ui-stop")?.status, "stopped");
	assert.equal(manager.get("agent-ui-stop")?.resultConsumed, undefined);
});
