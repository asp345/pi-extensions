import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

test("background subagents are detached from the parent turn abort signal", async () => {
	let childSignal: AbortSignal | undefined;
	const startSession = async (_ctx: ExtensionContext, request: { parentSignal?: AbortSignal }) => {
		childSignal = request.parentSignal;
		return { session: {} as AgentSession, text: "done" };
	};
	const manager = new AgentManager(
		() => undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		startSession as never,
	);
	const parent = new AbortController();
	parent.abort();
	const record = manager.spawn({ cwd: process.cwd() } as ExtensionContext, definition, "task", {
		background: true,
		fork: false,
		signal: parent.signal,
	});
	await record.promise;
	assert.equal(childSignal?.aborted, false);
	assert.equal(record.status, "completed");
});
