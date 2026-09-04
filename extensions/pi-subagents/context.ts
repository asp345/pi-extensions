import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./types.ts";
import { contentText } from "./util.ts";

export const CONTEXT_ROWS = 30;
export const SCROLL_STEP = 10;

interface ContextTheme {
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
				`${theme.fg("accent", "●")} ${theme.fg("text", record.type)} ${theme.fg("text", record.title)} ${theme.fg("dim", `· ${record.model ?? "model pending"} · ${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools`)}`,
				width,
			),
		);
}

interface MessageBlock {
	id: string;
	entries: unknown[];
	isComplete: boolean;
}

interface AgentBlockCache {
	width: number;
	blocks: Map<string, string[]>;
}

const blockCaches = new Map<string, AgentBlockCache>();

export function clearAgentContextCache(agentId?: string): void {
	if (agentId) {
		blockCaches.delete(agentId);
	} else {
		blockCaches.clear();
	}
}

function groupMessagesIntoBlocks(messages: readonly unknown[]): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	let currentEntries: unknown[] = [];
	const expectedToolCallIds = new Set<string>();
	let blockStartIndex = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as {
			role?: string;
			stopReason?: string;
			content?: unknown[];
			toolCallId?: string;
		};

		if (msg.role === "user") {
			if (currentEntries.length > 0) {
				blocks.push({
					id: `blk-${blockStartIndex}`,
					entries: currentEntries,
					isComplete: true,
				});
				currentEntries = [];
				expectedToolCallIds.clear();
			}
			blockStartIndex = i;
			blocks.push({
				id: `blk-${i}`,
				entries: [msg],
				isComplete: true,
			});
		} else if (msg.role === "assistant") {
			if (currentEntries.length > 0) {
				blocks.push({
					id: `blk-${blockStartIndex}`,
					entries: currentEntries,
					isComplete: expectedToolCallIds.size === 0,
				});
				currentEntries = [];
				expectedToolCallIds.clear();
			}
			blockStartIndex = i;
			currentEntries.push(msg);
			const isDoneStreaming = Boolean(msg.stopReason);
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					const tool = part as { type?: string; id?: string };
					if (tool.type === "toolCall" && tool.id) {
						expectedToolCallIds.add(tool.id);
					}
				}
			}
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				expectedToolCallIds.clear();
			}
			if (isDoneStreaming && expectedToolCallIds.size === 0) {
				blocks.push({
					id: `blk-${blockStartIndex}`,
					entries: currentEntries,
					isComplete: true,
				});
				currentEntries = [];
			}
		} else if (msg.role === "toolResult") {
			currentEntries.push(msg);
			if (msg.toolCallId) {
				expectedToolCallIds.delete(msg.toolCallId);
			}
			if (expectedToolCallIds.size === 0) {
				blocks.push({
					id: `blk-${blockStartIndex}`,
					entries: currentEntries,
					isComplete: true,
				});
				currentEntries = [];
			}
		}
	}

	if (currentEntries.length > 0) {
		blocks.push({
			id: `blk-${blockStartIndex}`,
			entries: currentEntries,
			isComplete: false,
		});
	}

	return blocks;
}

function renderBlock(entries: readonly unknown[], width: number, record: AgentRecord, tui: TUI, cwd: string): string[] {
	const contentWidth = width;
	const conversation = new Container();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const markdownTheme = getMarkdownTheme();

	for (const entry of entries) {
		const msg = entry as { role?: string; content?: unknown };
		if (msg.role === "user") {
			const text = contentText(msg.content).trim();
			if (text) conversation.addChild(new UserMessageComponent(text, markdownTheme, 1));
			continue;
		}
		if (msg.role === "assistant") {
			const assistant = msg as AssistantMessage;
			conversation.addChild(new AssistantMessageComponent(assistant, false, markdownTheme, "Thinking...", 1));
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
				} else {
					pendingTools.set(part.id, component);
				}
			}
			continue;
		}
		if (msg.role === "toolResult") {
			const toolResult = msg as { toolCallId: string };
			const component = pendingTools.get(toolResult.toolCallId);
			if (component) {
				component.updateResult(toolResult as never);
				pendingTools.delete(toolResult.toolCallId);
			}
		}
	}

	const lines = conversation.render(contentWidth).map((line) => truncateToWidth(line, contentWidth));
	return lines.map((line) => {
		const content = truncateToWidth(line, width);
		return `${content}\x1b[0m${" ".repeat(Math.max(0, width - visibleWidth(content)))}`;
	});
}

type ScrollPosition = number | { topLine: number } | null | undefined;

export function buildAgentContextFullLines(
	record: AgentRecord,
	width: number,
	theme: ContextTheme,
	tui: TUI,
	cwd: string,
): string[] {
	if (width < 3) return [];

	let cache = blockCaches.get(record.id);
	if (!cache || cache.width !== width) {
		cache = { width, blocks: new Map() };
		blockCaches.set(record.id, cache);
	}

	const messages = record.session?.messages ?? [];
	const blocks = groupMessagesIntoBlocks(messages);
	const allLines: string[] = [];

	for (const block of blocks) {
		let lines: string[] | undefined;
		if (block.isComplete) {
			lines = cache.blocks.get(block.id);
			if (!lines) {
				lines = renderBlock(block.entries, width, record, tui, cwd);
				cache.blocks.set(block.id, lines);
			}
		} else {
			lines = renderBlock(block.entries, width, record, tui, cwd);
		}
		allLines.push(...lines);
	}

	if (!allLines.length) {
		allLines.push(theme.fg("dim", "Waiting for agent activity…"));
	}

	return allLines;
}

export function renderAgentContext(
	record: AgentRecord,
	width: number,
	theme: ContextTheme,
	tui: TUI,
	cwd: string,
	rows = CONTEXT_ROWS,
	scrollPosition: ScrollPosition = null,
): string[] {
	if (width < 3 || rows < 1) return [];

	const allLines = buildAgentContextFullLines(record, width, theme, tui, cwd);

	let start: number;
	let end: number;

	if (typeof scrollPosition === "object" && scrollPosition !== null && "topLine" in scrollPosition) {
		start = Math.max(0, Math.min(scrollPosition.topLine, Math.max(0, allLines.length - rows)));
		end = Math.min(allLines.length, start + rows);
	} else if (typeof scrollPosition === "number" && scrollPosition > 0) {
		const offset = Math.min(scrollPosition, Math.max(0, allLines.length - rows));
		end = Math.max(0, allLines.length - offset);
		start = Math.max(0, end - rows);
	} else {
		end = allLines.length;
		start = Math.max(0, end - rows);
	}

	const visible = allLines.slice(start, end);
	const blank = `\x1b[0m${" ".repeat(width)}`;
	while (visible.length < rows) visible.unshift(blank);
	return visible;
}
