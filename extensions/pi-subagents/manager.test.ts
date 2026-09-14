import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcProcess } from "./rpc.ts";
import type { AgentDefinition } from "./types.ts";

const { AgentManager } = await import("./manager.ts");
const definition: AgentDefinition = {
	name: "Test",
	description: "test",
	tools: [],
	extensions: false,
	excludeExtensions: [],
	skills: false,
	models: ["parent"],
	persistSession: false,
	outputTranscript: false,
	promptMode: "append",
	fork: false,
	runInBackground: true,
	worktree: false,
	enabled: true,
	path: "Test.md",
	source: "default",
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

test("background subagents are detached from the parent turn abort signal", async () => {
	let childSignal: AbortSignal | undefined;
	const startSession = async (_ctx: ExtensionContext, request: { parentSignal?: AbortSignal }) => {
		childSignal = request.parentSignal;
		return { proc: fakeProc(), text: "done", messages: [] };
	};
	const manager = new AgentManager(
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		startSession as never,
	);
	const parent = new AbortController();
	parent.abort();
	const record = manager.spawn({ cwd: process.cwd() } as ExtensionContext, definition, "Task title", "task", {
		background: true,
		fork: false,
		signal: parent.signal,
	});
	await record.promise;
	assert.equal(childSignal?.aborted, false);
	assert.equal(record.status, "completed");
});

test("stopped subagents retain their ID and process when resumed", async () => {
	let aborted = false;
	const messages: Array<Record<string, unknown>> = [];
	const proc = fakeProc({
		async abort() {
			aborted = true;
		},
		async prompt() {
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
	const manager = new AgentManager(
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
	);
	manager.restore([
		{
			id: "agent-id",
			type: "Test",
			title: "Task title",
			prompt: "task",
			cwd: process.cwd(),
			status: "running",
			background: true,
			startedAt: Date.now(),
			turns: 1,
			toolUses: 0,
			models: [],
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

	const resumed = await manager.resume({} as ExtensionContext, "agent-id", "continue", {
		title: "Task title",
		background: false,
		models: [],
		definition,
	});
	assert.equal(resumed.id, "agent-id");
	assert.equal(resumed.status, "completed");
	assert.equal(resumed.result, "resumed");
});
