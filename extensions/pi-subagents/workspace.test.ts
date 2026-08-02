import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, DefinitionRegistry } from "./types.ts";

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

const { loadThemeFromPath, setThemeInstance } = await import(
	"../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
);
setThemeInstance(
	loadThemeFromPath(
		fileURLToPath(
			new URL(
				"../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
				import.meta.url,
			),
		),
	),
);
const { showAgentWorkspace } = await import("./workspace.ts");

type WorkspaceComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
};

interface FakeTui {
	terminal: { rows: number };
	requestRender(): void;
}

interface FakeTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface WorkspaceFixture {
	record: AgentRecord;
	tui: FakeTui;
	component: WorkspaceComponent;
	update(): void;
	close(): Promise<void>;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function workspaceFixture(
	options: { rows?: number; messages?: unknown[]; toolsExpanded?: boolean } = {},
): WorkspaceFixture {
	const record: AgentRecord = {
		id: "agent-1",
		type: "Explore",
		prompt: "test",
		status: "running",
		background: true,
		startedAt: Date.now(),
		turns: 0,
		toolUses: 0,
		model: "openai-codex/gpt-5.6-luna",
		models: [],
		abortController: new AbortController(),
		pendingSteers: [],
	};
	if (options.messages) {
		record.session = { messages: options.messages, getToolDefinition: () => undefined } as never;
	}
	const tui: FakeTui = { terminal: { rows: options.rows ?? 40 }, requestRender: () => undefined };
	const theme: FakeTheme = { fg: (_color, text) => text, bold: (text) => text };
	let component: WorkspaceComponent | undefined;
	let done: ((result: { action: "close" | "definitions" | "create"; selectedId?: string }) => void) | undefined;
	const context = {
		cwd: process.cwd(),
		ui: {
			custom: <T>(
				factory: (tui: FakeTui, theme: FakeTheme, keys: unknown, done: (result: T) => void) => WorkspaceComponent,
			) =>
				new Promise<T>((resolve) => {
					component = factory(
						tui,
						theme,
						{ matches: (data: string, action: string) => data === "\x0f" && action === "app.tools.expand" },
						resolve,
					);
					done = resolve as typeof done;
				}),
			setFooter: () => undefined,
			notify: () => undefined,
			getToolsExpanded: () => options.toolsExpanded ?? false,
		},
	} as unknown as ExtensionContext;
	const manager = {
		list: () => [record],
		running: () => [record],
		steer: () => true,
		resume: async () => record,
		cancel: () => true,
		clearFinished: () => 0,
	};
	const registry = (): DefinitionRegistry => ({ definitions: new Map(), errors: [] });
	let update: (() => void) | undefined;
	const workspace = showAgentWorkspace(context, manager as never, registry, record.id, (refresh) => {
		update = refresh;
	});
	assert.ok(component);
	return {
		record,
		tui,
		component,
		update: () => update?.(),
		close: async () => {
			done?.({ action: "close" });
			await workspace;
		},
	};
}

test("workspace heading and selector show the active model beside the agent name", async () => {
	const fixture = workspaceFixture();
	assert.match(fixture.component.render(100).join("\n"), /Explore · openai-codex\/gpt-5\.6-luna/u);
	fixture.component.handleInput("\x1b[B");
	assert.match(fixture.component.render(100).join("\n"), /Explore · openai-codex\/gpt-5\.6-luna/u);
	await fixture.close();
});

test("workspace uses the main transcript components for assistant markdown and tool calls", async () => {
	const assistant = assistantMessage("**Inspecting the file**");
	assistant.content.push({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/sample.ts" } });
	assistant.stopReason = "toolUse";
	const fixture = workspaceFixture({
		messages: [
			{ role: "user", content: "Inspect the sample", timestamp: Date.now() },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "const answer = 42;" }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			},
		],
	});
	assert.doesNotMatch(fixture.component.render(100).join("\n"), /answer =/u);
	fixture.component.handleInput("\x0f");
	const rendered = fixture.component.render(100).join("\n");
	assert.match(rendered, /Inspecting the file/u);
	assert.match(rendered, /read/u);
	assert.match(rendered, /src\/sample\.ts/u);
	assert.match(rendered, /answer =/u);
	assert.match(rendered, /42/u);
	assert.doesNotMatch(rendered, /\[Tool: read\]/u);
	await fixture.close();
});

test("workspace renderer keeps a fixed, width-safe viewport while paging", async () => {
	const fixture = workspaceFixture();
	for (const lines of [
		fixture.component.render(80),
		(fixture.component.handleInput("\x1b[5~"), fixture.component.render(80)),
	]) {
		assert.equal(lines.length, 28);
		for (const line of lines) assert.equal(visibleWidth(line), 80);
	}
	await fixture.close();
});

test("workspace framing expands tabs and closes ANSI styling before padding", async () => {
	const fixture = workspaceFixture({ messages: [assistantMessage("\x1b[41ma\tb")] });
	const coloured = fixture.component.render(20).find((line) => line.includes("\x1b[41m"));
	assert.ok(coloured);
	assert.ok(!coloured.includes("\t"));
	assert.equal(visibleWidth(coloured), 20);
	assert.match(coloured, /\x1b\[0m │$/u);
	await fixture.close();
});

test("workspace preserves conversation scroll when the agent selector opens", async () => {
	const messages = Array.from({ length: 20 }, (_, index) => ({ role: "user", content: `message-${index}` }));
	const fixture = workspaceFixture({ messages });
	fixture.component.render(80);
	fixture.component.handleInput("\x1b[5~");
	const beforeSelector = fixture.component.render(80);
	fixture.component.handleInput("\x1b[B");
	assert.match(fixture.component.render(80).join("\n"), /Agents/u);
	fixture.component.handleInput("\x1b");
	assert.deepEqual(fixture.component.render(80), beforeSelector);
	await fixture.close();
});

test("workspace never renders more rows than the overlay budget", async () => {
	const fixture = workspaceFixture({ rows: 10 });
	const lines = fixture.component.render(80);
	assert.equal(lines.length, 7);
	for (const line of lines) assert.equal(visibleWidth(line), 80);
	await fixture.close();
});

test("workspace invalidates cached conversation lines when an agent updates", async () => {
	const messages = [assistantMessage("before")];
	const fixture = workspaceFixture({ messages });
	assert.match(fixture.component.render(80).join("\n"), /before/u);
	messages[0] = assistantMessage("after");
	fixture.update();
	assert.match(fixture.component.render(80).join("\n"), /after/u);
	await fixture.close();
});
