import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
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

function workspaceFixture(options: { rows?: number; messages?: unknown[] } = {}): WorkspaceFixture {
	const record: AgentRecord = {
		id: "agent-1",
		type: "Explore",
		prompt: "test",
		status: "running",
		background: true,
		startedAt: Date.now(),
		turns: 0,
		toolUses: 0,
		models: [],
		abortController: new AbortController(),
		pendingSteers: [],
	};
	if (options.messages) record.session = { messages: options.messages } as never;
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
					component = factory(tui, theme, undefined, resolve);
					done = resolve as typeof done;
				}),
			setFooter: () => undefined,
			notify: () => undefined,
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
	const fixture = workspaceFixture({ messages: [{ role: "assistant", content: "\x1b[41ma\tb" }] });
	const coloured = fixture.component.render(20).find((line) => line.includes("\x1b[41m"));
	assert.ok(coloured);
	assert.ok(!coloured.includes("\t"));
	assert.equal(visibleWidth(coloured), 20);
	assert.match(coloured, /\x1b\[0m {11} │$/u);
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
	const messages = [{ role: "assistant", content: "before" }];
	const fixture = workspaceFixture({ messages });
	assert.match(fixture.component.render(80).join("\n"), /before/u);
	messages[0] = { role: "assistant", content: "after" };
	fixture.update();
	assert.match(fixture.component.render(80).join("\n"), /after/u);
	await fixture.close();
});
