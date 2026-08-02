import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./types.ts";

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
const { renderAgentContext, renderAgentList } = await import("./context.ts");

const theme = { fg: (_color: "accent" | "borderMuted" | "dim" | "text", text: string) => text };
const tui = { requestRender: () => undefined };

function record(messages: unknown[]): AgentRecord {
	return {
		id: "agent-12345678",
		type: "Explore",
		prompt: "inspect",
		status: "running",
		background: true,
		startedAt: Date.now(),
		turns: 1,
		toolUses: 0,
		model: "provider/model",
		models: [],
		session: { messages, getToolDefinition: () => undefined } as never,
		abortController: new AbortController(),
		pendingSteers: [],
	};
}

test("default agent list is compact and titleless", () => {
	const lines = renderAgentList([record([]), { ...record([]), id: "agent-87654321", type: "Worker" }], 80, theme);

	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /^● Explore/u);
	assert.match(lines[1] ?? "", /^● Worker/u);
	assert.doesNotMatch(lines.join("\n"), /Agents \(|Subagent context/u);
});

test("subagent context is titleless, bounded, and shows the latest activity", () => {
	const messages = Array.from({ length: 30 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `activity-${index}` }],
	}));
	const lines = renderAgentContext(record(messages), 30, theme, tui as never, process.cwd());

	assert.equal(lines.length, 20);
	assert.match(lines.at(-1) ?? "", /activity-29/u);
	assert.doesNotMatch(lines.join("\n"), /Explore|provider\/model|agent-12345678/u);
	for (const line of lines) {
		assert.equal(visibleWidth(line), 30);
		assert.match(line, /\x1b\[0m *$/u);
	}

	const previousPage = renderAgentContext(record(messages), 30, theme, tui as never, process.cwd(), 20, 20);
	assert.notDeepEqual(previousPage, lines);
	assert.doesNotMatch(previousPage.join("\n"), /activity-29/u);
});

test("subagent context reuses the main tool renderer and background", () => {
	const lines = renderAgentContext(
		record([
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "read", id: "call-1", arguments: { path: "sample.ts" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `output-${index}`).join("\n") }],
			},
		]),
		40,
		theme,
		tui as never,
		process.cwd(),
	);

	assert.match(lines.join("\n"), /read/u);
	assert.match(lines.join("\n"), /sample\.ts/u);
	assert.match(lines.join("\n"), /\x1b\[48;2;/u);
	assert.ok(lines.every((line) => !line.startsWith("│ ")));
	assert.ok(lines.every((line) => visibleWidth(line) === 40));
	assert.ok(lines.every((line) => /\x1b\[0m *$/u.test(line)));
	assert.ok(lines.every((line) => !/[╭╮╰╯]/u.test(line)));
});
