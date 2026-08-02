import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { contentText } from "./runner.js";
import type { AgentRecord } from "./types.js";

export const CONTEXT_ROWS = 20;

export interface ContextTheme {
	fg(color: "accent" | "borderMuted" | "dim" | "text", text: string): string;
}

export function renderAgentList(
	records: readonly AgentRecord[],
	width: number,
	theme: ContextTheme,
	visible = 4,
): string[] {
	return records
		.slice(0, visible)
		.map((record) =>
			truncateToWidth(
				`${theme.fg("accent", "●")} ${theme.fg("text", record.type)} ${theme.fg("dim", `· ${record.model ?? "model pending"} · ${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools`)}`,
				width,
			),
		);
}

export function renderAgentContext(
	record: AgentRecord,
	width: number,
	theme: ContextTheme,
	tui: TUI,
	cwd: string,
	rows = CONTEXT_ROWS,
	scrollOffset = 0,
): string[] {
	if (width < 3 || rows < 1) return [];
	const contentWidth = width;
	const conversation = new Container();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const markdownTheme = getMarkdownTheme();
	for (const entry of record.session?.messages.slice(-24) ?? []) {
		if (entry.role === "user") {
			const text = contentText(entry.content).trim();
			if (text) conversation.addChild(new UserMessageComponent(text, markdownTheme, 0));
			continue;
		}
		if (entry.role === "assistant") {
			const assistant = entry as AssistantMessage;
			conversation.addChild(new AssistantMessageComponent(assistant, false, markdownTheme, "Thinking...", 0));
			for (const part of assistant.content) {
				if (part.type !== "toolCall") continue;
				const component = new ToolExecutionComponent(
					part.name,
					part.id,
					part.arguments,
					{ showImages: false },
					record.session?.getToolDefinition(part.name),
					tui,
					record.worktree?.cwd ?? cwd,
				);
				component.setExpanded(false);
				conversation.addChild(component);
				if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
					component.updateResult({
						content: [{ type: "text", text: assistant.errorMessage || "Agent request failed" }],
						isError: true,
					});
				} else pendingTools.set(part.id, component);
			}
			continue;
		}
		if (entry.role === "toolResult") {
			const component = pendingTools.get(entry.toolCallId);
			if (component) {
				component.updateResult(entry);
				pendingTools.delete(entry.toolCallId);
			}
		}
	}
	let lines = conversation.render(contentWidth).map((line) => truncateToWidth(line, contentWidth));
	if (!lines.length) lines = [theme.fg("dim", "Waiting for agent activity…")];
	const offset = Math.min(Math.max(0, scrollOffset), Math.max(0, lines.length - rows));
	const end = Math.max(0, lines.length - offset);
	const start = Math.max(0, end - rows);
	const visible = lines.slice(start, end);
	while (visible.length < rows) visible.unshift("");
	return visible.map((line) => {
		const content = truncateToWidth(line, width);
		return `${content}\x1b[0m${" ".repeat(Math.max(0, width - visibleWidth(content)))}`;
	});
}
