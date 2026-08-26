import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./types.ts";

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
const { CONTEXT_ROWS, renderAgentContext, renderAgentList } = await import("./context.ts");

const theme = { fg: (_color: "accent" | "borderMuted" | "dim" | "text", text: string) => text };
const tui = { requestRender: () => undefined };

function record(messages: unknown[]): AgentRecord {
	return {
		id: "agent-12345678",
		type: "Explore",
		title: "Inspect parser",
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
	assert.match(lines[0] ?? "", /^● Explore Inspect parser/u);
	assert.match(lines[1] ?? "", /^● Worker Inspect parser/u);
	assert.doesNotMatch(lines.join("\n"), /Agents \(|Subagent context/u);
});

test("subagent context is titleless, bounded, and shows the latest activity", () => {
	const messages = Array.from({ length: 30 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `activity-${index}` }],
	}));
	const lines = renderAgentContext(record(messages), 30, theme, tui as never, process.cwd());

	assert.equal(lines.length, CONTEXT_ROWS);
	assert.match(lines.at(-1) ?? "", /activity-29/u);
	assert.doesNotMatch(lines.join("\n"), /Explore|provider\/model|agent-12345678/u);
	for (const line of lines) {
		assert.equal(visibleWidth(line), 30);
		assert.match(line, /\x1b\[0m *$/u);
	}

	const previousPage = renderAgentContext(
		record(messages),
		30,
		theme,
		tui as never,
		process.cwd(),
		CONTEXT_ROWS,
		CONTEXT_ROWS,
	);
	assert.notDeepEqual(previousPage, lines);
	assert.doesNotMatch(previousPage.join("\n"), /activity-29/u);
});
