/**
 * compact-ui: merge thinking + tool calls into a single tree-shaped block.
 *
 * Tool calls are intercepted at the container-prototype level (like
 * pi-cc-extensions) and collected into a ToolGroupComponent rendered in place
 * in the transcript. Thinking text is captured from message_update events and
 * merged into the same block.
 *
 * Collapsed (max 3 lines by default, configurable):
 *   ⠋ tool calling...
 *   │  ✓ bash: ls /tmp && cat fi... (3s)
 *   └  · thinking: Planning... · ≈1.2K tok
 *
 * Ctrl+O toggles collapse/expand (via setExpanded, same as built-in tools).
 * Expand line counts are configurable via /compact-config (interactive
 * settings menu, arrows to select, Enter to adjust, Esc to close) and are
 * persisted to ~/.pi/agent/compact-ui.json:
 *   { "collapsedMaxLines": 3, "expandedToolLines": 5, "expandedThinkingLines": 10 }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	getSettingsListTheme,
	type Theme,
	type ThemeColor,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, DefaultTextStyle, MarkdownTheme, SettingItem, TUI } from "@earendil-works/pi-tui";
import {
	Container,
	Key,
	Markdown,
	matchesKey,
	SettingsList,
	Spacer,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

// =============================================================================
// Config
// =============================================================================
const CONFIG_PATH = join(getAgentDir(), "compact-ui.json");
const DEFAULT_CONFIG = { collapsedMaxLines: 3, expandedToolLines: 5, expandedThinkingLines: 10 };
let config = { ...DEFAULT_CONFIG };
try {
	config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
} catch {
	// first run — use defaults
}

type ConfigKey = keyof typeof config;

function isConfigKey(id: string): id is ConfigKey {
	return id in config;
}

function saveConfig(): void {
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	} catch {
		// ignore
	}
}

// Interactive editor metadata for each numeric option.
const CONFIG_KEYS = [
	{
		id: "collapsedMaxLines",
		label: "Collapsed max lines",
		description: "Max lines shown when a tool group is collapsed",
		min: 2,
		max: 20,
		step: 1,
	},
	{
		id: "expandedToolLines",
		label: "Expanded tool lines",
		description: "Result lines shown per tool when expanded",
		min: 1,
		max: 50,
		step: 1,
	},
	{
		id: "expandedThinkingLines",
		label: "Expanded thinking lines",
		description: "Thinking lines shown when expanded",
		min: 1,
		max: 100,
		step: 1,
	},
] as const;

// Numeric stepper submenu: ◀/▶ (or −/+) adjust the value, Enter saves, Esc
// cancels. `done(undefined)` means "no change".
function makeStepper(
	title: string,
	initial: number,
	meta: { min: number; max: number; step: number },
	theme: Theme,
	done: (value?: string) => void,
): Component {
	let value = initial;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const fg = (color: ThemeColor, t: string): string => theme.fg(color, t);

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const barLen = Math.max(1, Math.min(width - 10, 40));
			const ratio = (value - meta.min) / Math.max(1, meta.max - meta.min);
			const filled = Math.round(ratio * barLen);
			const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
			const titleText = theme.bold(title);
			cachedLines = [
				fg("accent", titleText),
				"",
				`  ${fg("accent", String(value))}`,
				`  ${fg("muted", bar)}`,
				"",
				fg("dim", "  ◀ ▶ / − +  adjust    Enter  save    Esc  cancel"),
			].map((line) => truncateToWidth(line, Math.max(1, width)));
			cachedWidth = width;
			return cachedLines;
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.down) || data === "-" || data === "_") {
				value = Math.max(meta.min, value - meta.step);
			} else if (matchesKey(data, Key.right) || matchesKey(data, Key.up) || data === "+" || data === "=") {
				value = Math.min(meta.max, value + meta.step);
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				done(String(value));
				return;
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			cachedWidth = undefined;
		},
		invalidate(): void {
			cachedWidth = undefined;
		},
	};
}

// =============================================================================
// Shared state
// =============================================================================
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 100ms/frame (10fps) matches pi's default spinner cadence; 300ms felt laggy.
const SPINNER_MS = 100;
const GROUP_PADDING_X = 1;
const spinnerStart = Date.now();
const PATCH_KEY = Symbol.for("compact-ui.group-patch");
const COMPACTION_STYLE_PATCH_KEY = Symbol.for("compact-ui.compaction-style-patch");

let currentTheme: Theme | null = null;
let thinkingActive = false;
let thinkingText = "";
// Most providers report reasoning usage only when the response finishes. While
// streaming, fall back to pi's own chars/4 token heuristic and mark it with ≈.
let thinkingTokenCount = 0;
let thinkingTokenCountExact = false;
// message_update contains a cumulative AssistantMessage snapshot. Track stream
// content indexes so growing text deltas seal a block only once.
const handledTextIndexes = new Set<number>();
const thinkingBlocks = new Map<number, string>();
let assistantThinkingStarted = false;
let pendingTextSeal = false;
let pendingTextOrdinal: number | null = null;
let lastActiveGroup: ToolGroupComponent | null = null;
// Track the current assistant message's component + the container it lives in,
// so a thinking-only group can be inserted right after it (before any tool).
let lastStreamingComp: AssistantMessageComponent | null = null;
let lastChatContainer: Container | null = null;
const toolStarts = new Map<string, number>();
// Wall-clock start of the current turn (user message), used to render the
// "worked for Xm Ys" divider before the final visible text.
let turnStartMs = 0;

// =============================================================================
// Tool summary helpers
// =============================================================================
function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown, max = 60): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function formatTokenK(tokens: number): string {
	if (tokens <= 0) return "0.0K";
	if (tokens < 100) return "<0.1K";
	const value = tokens / 1000;
	return value < 100 ? `${value.toFixed(1)}K` : `${Math.round(value)}K`;
}

function themeFg(theme: Theme | null, color: ThemeColor, text: string): string {
	return theme?.fg(color, text) ?? text;
}

function themeBold(theme: Theme | null, text: string): string {
	return theme?.bold(text) ?? text;
}

function updateThinkingTokenCount(message: AssistantMessage): void {
	const reported = Number(message.usage?.reasoning);
	if (Number.isFinite(reported) && reported > 0) {
		thinkingTokenCount = reported;
		thinkingTokenCountExact = true;
		return;
	}
	thinkingTokenCount = estimateTextTokens(thinkingText);
	thinkingTokenCountExact = false;
}

function argString(args: unknown, key: string): string {
	if (typeof args !== "object" || args === null) return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function toolSummary(name: string, args: unknown): { name: string; content: string } {
	switch (name) {
		case "bash":
			return { name: "bash", content: oneLine(argString(args, "command") || "…") };
		case "read":
			return { name: "read", content: shortenPath(argString(args, "path") || "…") };
		case "write":
		case "edit":
			return { name, content: shortenPath(argString(args, "path") || "…") };
		case "find":
			return {
				name: "find",
				content: `${oneLine(argString(args, "pattern"))} in ${shortenPath(argString(args, "path") || ".")}`,
			};
		case "grep":
			return {
				name: "grep",
				content: `${oneLine(argString(args, "pattern"))} in ${shortenPath(argString(args, "path") || ".")}`,
			};
		case "ls":
			return { name: "ls", content: shortenPath(argString(args, "path") || ".") };
		case "web_search":
			return { name: "web_search", content: oneLine(argString(args, "query") || "…") };
		case "subagent":
			return { name: "subagent", content: oneLine(argString(args, "agent") || argString(args, "task") || "…") };
		default: {
			const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
			const preferred = record?.path ?? record?.query ?? record?.name ?? record?.description ?? record?.url;
			return { name, content: oneLine(preferred ?? "…") };
		}
	}
}

type ToolStatus = "pending" | "success" | "error";

function statusIcon(status: ToolStatus, frame: string): string {
	return status === "pending" ? frame : status === "error" ? "✗" : "✓";
}

function statusColor(status: ToolStatus): ThemeColor {
	return status === "pending" ? "accent" : status === "error" ? "error" : "success";
}

interface GroupHeadState {
	pending: boolean;
	thinking: boolean;
	openEmpty: boolean;
}

function groupHead(frame: string, state: GroupHeadState): { icon: string; label: string; color: ThemeColor } {
	if (state.pending) return { icon: frame, label: "tool calling...", color: "accent" };
	if (state.thinking || state.openEmpty) return { icon: frame, label: "thinking...", color: "thinkingText" };
	return { icon: "✓", label: "tools done", color: "success" };
}

interface ToolResultView {
	readonly isError?: boolean;
	readonly content?: readonly unknown[];
}

interface ToolView extends Component {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
	readonly isPartial?: boolean;
	readonly executionStarted?: boolean;
	readonly result?: ToolResultView;
	setExpanded?(expanded: boolean): void;
}

function asToolView(component: Component): ToolView | undefined {
	if (component instanceof ToolExecutionComponent) return component as unknown as ToolView;
	return undefined;
}

function toolStatus(tool: ToolView): ToolStatus {
	if (tool.result?.isError) return "error";
	if (tool.isPartial === true || (tool.executionStarted && !tool.result)) return "pending";
	return tool.result ? "success" : "pending";
}

const toolEndAts = new Map<string, number>();

function toolElapsed(tool: ToolView): string {
	const start = toolStarts.get(tool.toolCallId) ?? Date.now();
	const end = tool.result ? (toolEndAts.get(tool.toolCallId) ?? Date.now()) : Date.now();
	return ((end - start) / 1000).toFixed(1);
}

function isTextPart(part: unknown): part is { type: unknown; text?: unknown } {
	return typeof part === "object" && part !== null;
}

function toolResultText(tool: ToolView): string {
	const content = tool.result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextPart)
		.filter((part) => part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
}

type MarkdownPreview = {
	source: string;
	width: number;
	maxLines: number;
	lines: string[];
	truncated: boolean;
};

// Compact code fence markers are exactly "┌─" or "┌─ <language>", and the
// close row is exactly "└─". Markdown tables reuse the same box-drawing
// prefix ("┌─────┬──────┐") and must not enter code-block mode.
function isCompactCodeBlockOpen(visible: string): boolean {
	return visible === "┌─" || visible.startsWith("┌─ ");
}

function isCompactCodeBlockClose(visible: string): boolean {
	return visible === "└─";
}

// Pi's Markdown component normally renders fenced code blocks with literal
// ``` delimiters. Compact blocks use a tree-friendly border instead while
// retaining syntax highlighting. Code rows deliberately have no left rail so
// selecting/copying them produces the original code rather than "│ code":
//
//   ━━ ts ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   const answer: number = 42;
//   ─────────────────────────────────────
export function getCompactMarkdownTheme(): MarkdownTheme {
	const base = getMarkdownTheme();
	let insideCodeBlock = false;
	const theme: MarkdownTheme = {
		...base,
		codeBlockIndent: "",
		codeBlockBorder(text: string): string {
			const opening = !insideCodeBlock;
			insideCodeBlock = !insideCodeBlock;
			const language = opening ? text.replace(/^```/, "").trim() : "";
			if (opening) {
				theme.codeBlockIndent = "";
			}
			const border = opening ? `┌─${language ? ` ${language}` : ""}` : "└─";
			return base.codeBlockBorder(border);
		},
	};
	return theme;
}

function renderHorizontalCodeBorders(visibleMarker: string, width: number, opening: boolean): string[] {
	const safeWidth = Math.max(1, width);
	const language = opening ? visibleMarker.replace(/^┌─/, "").trim() : "";
	const label = opening && language ? ` ${language} ` : "";
	const linePrefix = opening ? `━━${label}` : "";
	const lineCharacter = opening ? "━" : "─";
	const lineWidth = Math.max(0, safeWidth - visibleWidth(linePrefix));
	const line = `${linePrefix}${lineCharacter.repeat(lineWidth)}`;
	const style = getMarkdownTheme().codeBlockBorder;
	return [style(line)];
}

export function normalizeCompactCodeBlockLines(lines: string[], width: number, paddingX = 0): string[] {
	const safeWidth = Math.max(1, width);
	const horizontalPadding = Math.max(0, Math.floor(paddingX));
	const leftPadding = " ".repeat(horizontalPadding);
	const contentWidth = Math.max(1, safeWidth - horizontalPadding * 2);
	const continuationWidth = contentWidth;
	const normalized: string[] = [];
	let codeBlockMode: "none" | "bordered" = "none";

	for (const originalLine of lines) {
		const withoutLeftPadding =
			leftPadding.length > 0 && originalLine.startsWith(leftPadding)
				? originalLine.slice(leftPadding.length)
				: originalLine;
		const content = withoutLeftPadding.trimEnd();
		const visible = stripTerminalSequences(content).trimStart();
		if (isCompactCodeBlockOpen(visible)) {
			codeBlockMode = "bordered";
			normalized.push(
				...renderHorizontalCodeBorders(visible, contentWidth, true).map((line) =>
					truncateToWidth(`${leftPadding}${line}`, safeWidth, "…"),
				),
			);
			continue;
		}
		if (isCompactCodeBlockClose(visible)) {
			codeBlockMode = "none";
			normalized.push(
				...renderHorizontalCodeBorders(visible, contentWidth, false).map((line) =>
					truncateToWidth(`${leftPadding}${line}`, safeWidth, "…"),
				),
			);
			continue;
		}
		if (codeBlockMode === "bordered") {
			// Code rows have no prefix. Rewrap at the full available width so
			// copied rows contain only the code text.
			for (const wrapped of wrapTextWithAnsi(content, continuationWidth)) {
				normalized.push(truncateToWidth(`${leftPadding}${wrapped}`, safeWidth, "…"));
			}
			continue;
		}
		normalized.push(truncateToWidth(originalLine, safeWidth, "…"));
	}

	return normalized;
}

export type CompactExternalTool = {
	id: string;
	name: string;
	args: unknown;
	status: ToolStatus;
	resultText: string;
	startedAt: number;
	endedAt?: number;
};

export type CompactExternalGroup = {
	tools: CompactExternalTool[];
	thinking: string;
	thinkingActive: boolean;
	sealed: boolean;
	thinkingTokens?: number;
	thinkingTokensExact?: boolean;
};

/**
 * Isolated compact-ui renderer for secondary transcripts (for example a
 * subagent overlay). It deliberately owns no main-session globals while using
 * the same colors, rails, Markdown/code rendering, limits, and expansion
 * behavior as ToolGroupComponent.
 */
export class CompactExternalGroupComponent implements Component {
	private expanded = false;

	constructor(
		readonly state: CompactExternalGroup,
		private readonly theme: Theme | null,
	) {}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	private elapsed(tool: CompactExternalTool): string {
		const end = tool.endedAt ?? Date.now();
		return `${Math.max(0, (end - tool.startedAt) / 1000).toFixed(1)}s`;
	}

	private toolRow(rail: string, tool: CompactExternalTool, frame: string): string {
		const fg = (color: ThemeColor, text: string): string => themeFg(this.theme, color, text);
		const bold = (text: string): string => themeBold(this.theme, text);
		const summary = toolSummary(tool.name, tool.args);
		return `${fg("dim", rail)}${fg(statusColor(tool.status), statusIcon(tool.status, frame))} ${fg("toolTitle", bold(summary.name))} ${fg("dim", summary.content)} ${fg("muted", `(${this.elapsed(tool)})`)}`;
	}

	private tokenLabel(): string {
		const tokens = this.state.thinkingTokens ?? estimateTextTokens(this.state.thinking);
		return `${this.state.thinkingTokensExact ? "" : "≈"}${formatTokenK(tokens)} tok`;
	}

	private markdownLines(source: string, width: number, maxLines: number, color: ThemeColor, italic = false): string[] {
		if (!source.trim()) return [];
		const lineLimit = Math.max(1, maxLines);
		const sourceRows = source.split("\n");
		const bounded = sourceRows
			.slice(0, Math.max(lineLimit * 4, lineLimit + 20))
			.join("\n")
			.slice(0, Math.max(4096, lineLimit * Math.max(40, width) * 4));
		const markdown = new Markdown(bounded, 0, 0, getCompactMarkdownTheme(), {
			color: (text: string): string => themeFg(this.theme, color, text),
			italic,
		});
		const rendered = normalizeCompactCodeBlockLines(markdown.render(Math.max(1, width)), Math.max(1, width));
		const lines = rendered.slice(0, lineLimit);
		if (rendered.length > lineLimit || bounded.length < source.length) {
			lines.push(themeFg(this.theme, "muted", "…"));
		}
		return lines;
	}

	private renderCollapsed(width: number, frame: string): string[] {
		const fg = (color: ThemeColor, text: string): string => themeFg(this.theme, color, text);
		const head = groupHead(frame, {
			pending: this.state.tools.some((tool) => tool.status === "pending"),
			thinking: this.state.thinkingActive && !this.state.sealed,
			openEmpty: !this.state.sealed && this.state.tools.length === 0,
		});
		const lines = [`${fg(head.color, head.icon)} ${fg(head.color, head.label)}`];
		const maxLines = Math.max(2, config.collapsedMaxLines);
		const thinking = this.state.thinking.trim().replace(/[*_#`>]+/g, "");
		const reserveThinking = thinking.length > 0;
		let shown = 0;
		for (let index = this.state.tools.length - 1; index >= 0; index--) {
			if (lines.length >= maxLines - (reserveThinking ? 1 : 0)) break;
			const isOldest = index === 0 && !reserveThinking;
			const row = this.state.tools[index];
			if (row) lines.push(this.toolRow(isOldest ? "└  " : "│  ", row, frame));
			shown++;
		}
		if (shown < this.state.tools.length && lines.length < maxLines) {
			lines.push(`${fg("dim", "│  ")} ${fg("muted", `… +${this.state.tools.length - shown} more`)}`);
		}
		if (reserveThinking && lines.length < maxLines) {
			const previewWidth = Math.max(1, Math.min(50, width - GROUP_PADDING_X - 18 - this.tokenLabel().length));
			lines.push(
				`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", `thinking: ${oneLine(thinking, previewWidth)}`)} ${fg("muted", `· ${this.tokenLabel()}`)}`,
			);
		}
		return lines;
	}

	private renderExpanded(width: number, frame: string): string[] {
		const fg = (color: ThemeColor, text: string): string => themeFg(this.theme, color, text);
		const head = groupHead(frame, {
			pending: this.state.tools.some((tool) => tool.status === "pending"),
			thinking: this.state.thinkingActive && !this.state.sealed,
			openEmpty: !this.state.sealed && this.state.tools.length === 0,
		});
		const lines = [`${fg(head.color, head.icon)} ${fg(head.color, head.label)}`];
		for (let index = 0; index < this.state.tools.length; index++) {
			const tool = this.state.tools[index];
			if (!tool) continue;
			const last = index === this.state.tools.length - 1;
			const sub = last ? "    " : "│   ";
			lines.push(this.toolRow(last ? "└─ " : "├─ ", tool, frame));
			for (const row of this.markdownLines(
				tool.resultText,
				Math.max(1, width - GROUP_PADDING_X - sub.length),
				config.expandedToolLines,
				"toolOutput",
			)) {
				lines.push(`${fg("dim", sub)}${row}`);
			}
		}
		if (this.state.thinking.trim()) {
			lines.push(
				`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", "thinking")} ${fg("muted", `· ${this.tokenLabel()}`)}`,
			);
			for (const row of this.markdownLines(
				this.state.thinking,
				Math.max(1, width - GROUP_PADDING_X - 4),
				config.expandedThinkingLines,
				"thinkingText",
				true,
			)) {
				lines.push(`${fg("dim", "    ")}${row}`);
			}
		}
		return lines;
	}

	render(width: number): string[] {
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length] ?? "⠋";
		const source = this.expanded ? this.renderExpanded(width, frame) : this.renderCollapsed(width, frame);
		const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length);
		return source.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
	}
}

// AssistantMessageComponent already uses Markdown for visible final text, but
// pi's stock Markdown theme intentionally displays literal ``` fence rows.
// Replace only visible assistant Markdown instances with compact code borders;
// user/custom messages and hidden thinking Markdown retain their native theme.
const patchedMarkdown = new WeakSet<Markdown>();

interface MarkdownInternals {
	theme: MarkdownTheme;
	paddingX: unknown;
}

function markdownInternals(component: Markdown): MarkdownInternals {
	return component as unknown as MarkdownInternals;
}

function installVisibleAssistantMarkdownRendering(component: Markdown): void {
	if (patchedMarkdown.has(component)) return;
	patchedMarkdown.add(component);
	const internals = markdownInternals(component);
	internals.theme = getCompactMarkdownTheme();
	const originalRender = component.render.bind(component);
	const paddingX = Number(internals.paddingX) || 0;
	component.render = (width: number): string[] =>
		normalizeCompactCodeBlockLines(originalRender(width), width, paddingX);
	component.invalidate();
}

class CompactionHeaderComponent implements Component {
	constructor(private readonly tokensBefore: number) {}

	render(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: ThemeColor, text: string): string => themeFg(theme, color, text);
		const exactTokens = Math.max(0, this.tokensBefore).toLocaleString();
		const icon = fg("success", "›‹");
		const title = fg("success", "Context compacted");
		const detail = fg("muted", ` • ${exactTokens} tokens → summary`);
		const full = `${icon} ${title}${detail}`;
		if (visibleWidth(full) <= width) return [full];

		const compactTitle = fg("success", "Compacted");
		const compactDetail = fg("muted", ` • ${formatTokenK(this.tokensBefore)} tok`);
		return [truncateToWidth(`${icon} ${compactTitle}${compactDetail}`, Math.max(1, width), "…")];
	}

	invalidate(): void {}
}

interface CompactionPatch {
	originalUpdateDisplay?: () => void;
	originalSetExpanded?: (expanded: boolean) => void;
	installedUpdateDisplay?: () => void;
	installedSetExpanded?: (expanded: boolean) => void;
}

interface CompactionPrototype {
	updateDisplay(): void;
	setExpanded(expanded: boolean): void;
	clear(): void;
	addChild(component: Component): void;
	[COMPACTION_STYLE_PATCH_KEY]?: CompactionPatch;
}

interface CompactionInternals {
	message?: { tokensBefore?: unknown };
	paddingX: number;
	paddingY: number;
	setBgFn(bgFn?: (text: string) => string): void;
}

function compactionInternals(host: CompactionPrototype): CompactionInternals {
	return host as unknown as CompactionInternals;
}

function installCompactionSummaryRendering(): void {
	const prototype = CompactionSummaryMessageComponent.prototype as unknown as CompactionPrototype;
	const previous = prototype[COMPACTION_STYLE_PATCH_KEY];
	// Replace the previous compact-ui closure on hot reload while retaining
	// pi's original renderer for a future replacement.
	const previousInstalledUpdate = previous?.installedUpdateDisplay;
	const originalUpdateDisplay =
		previous && previousInstalledUpdate && prototype.updateDisplay === previousInstalledUpdate
			? (previous.originalUpdateDisplay ?? prototype.updateDisplay)
			: prototype.updateDisplay;
	const originalSetExpanded =
		previous?.installedSetExpanded && prototype.setExpanded === previous.installedSetExpanded
			? (previous.originalSetExpanded ?? prototype.setExpanded)
			: prototype.setExpanded;
	const installedUpdateDisplay = function (this: CompactionPrototype): void {
		const internals = compactionInternals(this);
		internals.paddingX = GROUP_PADDING_X;
		internals.paddingY = 0;
		internals.setBgFn(undefined);
		this.clear();

		const tokensBefore = Number(internals.message?.tokensBefore);
		const safeTokens = Number.isFinite(tokensBefore) && tokensBefore > 0 ? tokensBefore : 0;
		this.addChild(new CompactionHeaderComponent(safeTokens));
	};
	const installedSetExpanded = function (this: CompactionPrototype, _expanded: boolean): void {
		// Context compaction is a static transcript event. Global Ctrl+O remains
		// available for compact thinking/tool groups but does not alter this row.
	};
	prototype.updateDisplay = installedUpdateDisplay;
	prototype.setExpanded = installedSetExpanded;
	prototype[COMPACTION_STYLE_PATCH_KEY] = {
		originalUpdateDisplay,
		originalSetExpanded,
		installedUpdateDisplay,
		installedSetExpanded,
	};
}

// =============================================================================
// ToolGroupComponent
// =============================================================================
class ToolGroupComponent extends Container {
	readonly toolCallId = `compact-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	toolName = "group";
	/** Nested at a visible-text boundary rather than rendered at chat level. */
	anchored = false;
	private _expanded = false;
	get expanded(): boolean {
		return this._expanded;
	}
	/** Sealed: this block was closed by real text output — render from snapshot only. */
	sealed = false;
	/** Thinking snapshot captured when this block was sealed by text output. */
	thinkingFrozen = "";
	/** Token snapshot paired with thinkingFrozen. */
	thinkingTokensFrozen = 0;
	thinkingTokensFrozenExact = false;
	private markdownPreviewCache = new Map<string, MarkdownPreview>();

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		for (const tool of this.children) asToolView(tool)?.setExpanded?.(expanded);
		this.invalidate();
	}

	addTool(tool: ToolView): void {
		this.children.push(tool);
	}

	hasPending(): boolean {
		// Running tools only — global thinking alone must not keep the bar repainting.
		return groupTools(this).some((tool) => toolStatus(tool) === "pending");
	}

	/** True while this group should keep its spinner animating. */
	needsAnimation(): boolean {
		return (
			this.hasPending() ||
			(this === lastActiveGroup && !this.sealed && (thinkingActive || this.liveThinking().trim().length > 0))
		);
	}

	invalidate(): void {
		// Theme changes and tool/thinking updates must rebuild ANSI markdown.
		this.markdownPreviewCache.clear();
		super.invalidate();
	}

	private renderMarkdownPreview(
		cacheKey: string,
		source: string,
		width: number,
		maxLines: number,
		defaultTextStyle?: DefaultTextStyle,
	): MarkdownPreview {
		const renderWidth = Math.max(1, width);
		const lineLimit = Math.max(1, maxLines);
		const cached = this.markdownPreviewCache.get(cacheKey);
		if (cached && cached.source === source && cached.width === renderWidth && cached.maxLines === lineLimit) {
			return cached;
		}

		// Only a bounded prefix can become visible. This prevents a very large
		// command result from being reparsed in full merely to display a handful
		// of expanded lines. Incomplete closing fences are supported by pi-tui.
		const sourceRows = source.split("\n");
		const sourceLineLimit = Math.max(lineLimit * 4, lineLimit + 20);
		const sourceCharLimit = Math.max(4096, lineLimit * Math.max(40, renderWidth) * 4);
		let markdownSource = sourceRows.slice(0, sourceLineLimit).join("\n");
		let sourceTruncated = sourceRows.length > sourceLineLimit;
		if (markdownSource.length > sourceCharLimit) {
			markdownSource = markdownSource.slice(0, sourceCharLimit);
			sourceTruncated = true;
		}

		const markdown = new Markdown(markdownSource, 0, 0, getCompactMarkdownTheme(), defaultTextStyle);
		const rendered = normalizeCompactCodeBlockLines(markdown.render(renderWidth), renderWidth);
		const preview: MarkdownPreview = {
			source,
			width: renderWidth,
			maxLines: lineLimit,
			lines: rendered.slice(0, lineLimit),
			truncated: sourceTruncated || rendered.length > lineLimit,
		};
		this.markdownPreviewCache.set(cacheKey, preview);
		return preview;
	}

	// Tool name in bold accent, tool payload in dim.
	private toolRow(rail: string, tool: ToolView, frame: string): string {
		const theme = currentTheme;
		const fg = (color: ThemeColor, text: string): string => themeFg(theme, color, text);
		const bold = (text: string): string => themeBold(theme, text);
		const st = toolStatus(tool);
		const s = toolSummary(tool.toolName, tool.args);
		return `${fg("dim", rail)}${fg(statusColor(st), statusIcon(st, frame))} ${fg("toolTitle", bold(s.name))} ${fg("dim", s.content)} ${fg("muted", `(${toolElapsed(tool)}s)`)}`;
	}
	// Live state only applies to the not-yet-sealed (active) block.
	private liveThinking(): string {
		return this.sealed ? this.thinkingFrozen : this === lastActiveGroup ? thinkingText : this.thinkingFrozen;
	}
	private liveThinkingTokenLabel(): string {
		const tokens = this.sealed || this !== lastActiveGroup ? this.thinkingTokensFrozen : thinkingTokenCount;
		const exact = this.sealed || this !== lastActiveGroup ? this.thinkingTokensFrozenExact : thinkingTokenCountExact;
		return `${exact ? "" : "≈"}${formatTokenK(tokens)} tok`;
	}
	private liveThinkingActive(): boolean {
		return !this.sealed && thinkingActive;
	}

	// Folded: header + up to collapsedMaxLines total, ellipsis when exceeding.
	private renderCollapsed(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: ThemeColor, text: string): string => themeFg(theme, color, text);
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length] ?? "⠋";
		const lines: string[] = [];

		// An open block with no tools yet is still "thinking" (waiting for tools or
		// a text seal); only sealed / tool-bearing blocks show a completion mark.
		const head = groupHead(frame, {
			pending: this.hasPending(),
			thinking: this.liveThinkingActive(),
			openEmpty: !this.sealed && this.children.length === 0,
		});
		lines.push(`${fg(head.color, head.icon)} ${fg(head.color, head.label)}`);

		const maxLines = Math.max(2, config.collapsedMaxLines);
		const tools = groupTools(this);
		const total = tools.length;
		const tText = this.liveThinking()
			.trim()
			.replace(/[*_#`>]+/g, "");

		// Reserve the last line for the thinking footer when there is one.
		// Folded tools are listed newest-first: the most recent call sits on top.
		const keepThinking = tText.length > 0;
		let shown = 0;
		for (let index = 0; index < total; index++) {
			const room = maxLines - (keepThinking ? 1 : 0);
			if (lines.length >= room) break;
			const tool = tools[total - 1 - index];
			if (!tool) continue;
			const isLastTool = index === total - 1 && !keepThinking;
			const rail = isLastTool ? "└  " : "│  ";
			lines.push(this.toolRow(rail, tool, frame));
			shown++;
		}
		if (shown < total) {
			lines.push(`${fg("dim", "│  ")} ${fg("muted", `… +${total - shown} more`)}`);
		}
		if (keepThinking && lines.length < maxLines) {
			const tokenLabel = this.liveThinkingTokenLabel();
			const previewLimit = Math.max(1, Math.min(50, width - GROUP_PADDING_X - 18 - tokenLabel.length));
			lines.push(
				`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", `thinking: ${oneLine(tText, previewLimit)}`)} ${fg("muted", `· ${tokenLabel}`)}`,
			);
		}

		if (this.hasPending() || this.liveThinkingActive()) scheduleAnimation();
		return lines;
	}

	// Expanded: per-tool detail + thinking, line counts configurable.
	private renderExpanded(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: ThemeColor, text: string): string => themeFg(theme, color, text);
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length] ?? "⠋";
		const lines: string[] = [];

		const head = groupHead(frame, {
			pending: this.hasPending(),
			thinking: this.liveThinkingActive(),
			openEmpty: !this.sealed && this.children.length === 0,
		});
		lines.push(`${fg(head.color, head.icon)} ${fg(head.color, head.label)}`);

		const tools = groupTools(this);
		const total = tools.length;
		for (let index = 0; index < total; index++) {
			const tool = tools[index];
			if (!tool) continue;
			const isLast = index === total - 1;
			const rail = isLast ? "└─ " : "├─ ";
			const sub = isLast ? "    " : "│   ";
			lines.push(this.toolRow(rail, tool, frame));
			const result = toolResultText(tool);
			if (result) {
				const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
				const preview = this.renderMarkdownPreview(
					`tool:${tool.toolCallId ?? index}`,
					result,
					markdownWidth,
					config.expandedToolLines,
					{ color: (text: string): string => themeFg(currentTheme, "toolOutput", text) },
				);
				for (const row of preview.lines) {
					lines.push(`${fg("dim", sub)}${row}`);
				}
				if (preview.truncated) {
					lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
				}
			}
		}

		const tText = this.liveThinking().trim();
		if (tText) {
			lines.push(
				`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", "thinking")} ${fg("muted", `· ${this.liveThinkingTokenLabel()}`)}`,
			);
			const sub = "    ";
			const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
			const preview = this.renderMarkdownPreview("thinking", tText, markdownWidth, config.expandedThinkingLines, {
				color: (text: string): string => themeFg(currentTheme, "thinkingText", text),
				italic: true,
			});
			for (const row of preview.lines) {
				lines.push(`${fg("dim", sub)}${row}`);
			}
			if (preview.truncated) {
				lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
			}
		}

		if (this.hasPending() || this.liveThinkingActive()) scheduleAnimation();
		return lines;
	}

	render(width: number): string[] {
		const lines = this._expanded ? this.renderExpanded(width) : this.renderCollapsed(width);
		// Indent compact blocks from the transcript edge while keeping every line
		// within the terminal width (including mobile / narrow terminals).
		const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length);
		const rendered = lines.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
		// Native ToolExecutionComponent starts with Spacer(1). Our custom render
		// bypasses that child tree, so restore the same single leading gap while
		// the group is top-level. Anchored groups receive deterministic spacing
		// from placeAnchoredGroupBeforeText() instead.
		return this.anchored ? rendered : ["", ...rendered];
	}
}

function groupTools(group: ToolGroupComponent): ToolView[] {
	const views: ToolView[] = [];
	for (const child of group.children) {
		const view = asToolView(child);
		if (view) views.push(view);
	}
	return views;
}

// =============================================================================
// Animation scheduling. The TUI instance is captured via setWidget's factory
// (extensions can't requestRender directly). We tick at 300ms and call the
// throttled requestRender(), so the diff renderer updates only the changed
// spinner/elapsed cells — no full-screen repaint, no scroll fight.
// =============================================================================
let animTimer: ReturnType<typeof setTimeout> | null = null;
let capturedTui: Pick<TUI, "requestRender"> | null = null;

function scheduleAnimation(): void {
	if (animTimer) return;
	animTimer = setTimeout(() => {
		animTimer = null;
		let active = false;
		for (const group of groups) {
			const running = groupTools(group).some((tool) => toolStatus(tool) === "pending");
			const liveThinking = group === lastActiveGroup && !group.sealed && thinkingActive;
			if (running || liveThinking) {
				active = true;
			}
		}
		if (active) capturedTui?.requestRender();
	}, SPINNER_MS);
}

// =============================================================================
// Prototype patch
// =============================================================================
const groups = new Set<ToolGroupComponent>();

function previousGroupable(children: Component[], start: number): { child: Component; index: number } | undefined {
	for (let i = start; i >= 0; i--) {
		const child = children[i];
		if (child instanceof Spacer) continue;
		if (child instanceof AssistantMessageComponent) continue;
		return { child, index: i };
	}
	return undefined;
}

// Show a collapsed block as soon as thinking content appears (before any tool
// call). The block is inserted right after the current assistant message
// component so the message's (and later messages') tool calls join it via
// maybeGroup — as long as no real (non-thinking) text sealed it in between.
function ensureThinkingGroup(): void {
	if (!thinkingText.trim()) return; // nothing to show
	if (lastActiveGroup && !lastActiveGroup.sealed) return; // already an open block
	if (!lastChatContainer || !lastStreamingComp) return;
	const parent = lastChatContainer;
	const children = parent.children;
	const idx = children.indexOf(lastStreamingComp);
	const group = new ToolGroupComponent();
	children.splice(idx >= 0 ? idx + 1 : children.length, 0, group);
	groups.add(group);
	lastActiveGroup = group;
	parent.invalidate();
	capturedTui?.requestRender();
}

// A text stream is a boundary between compact blocks. The message_update event
// arrives before or after the matching AssistantMessageComponent depending on
// the renderer's event ordering, so defer the seal until that component exists.
function flushPendingTextSeal(): void {
	if (!pendingTextSeal) return;

	if ((!lastActiveGroup || lastActiveGroup.sealed) && thinkingText.trim()) {
		ensureThinkingGroup();
	}

	if (lastActiveGroup && !lastActiveGroup.sealed) {
		// The active group contains every thinking/tool event since the previous
		// visible text. Anchor it immediately before this text block so the visual
		// component order matches the stream order:
		//   group -> visible text -> next group -> next visible text
		if (pendingTextOrdinal !== null) {
			anchorGroupBeforeCurrentText(lastActiveGroup, pendingTextOrdinal);
		}
		lastActiveGroup.sealed = true;
		lastActiveGroup.thinkingFrozen = thinkingText;
		lastActiveGroup.thinkingTokensFrozen = thinkingTokenCount;
		lastActiveGroup.thinkingTokensFrozenExact = thinkingTokenCountExact;
		lastActiveGroup.invalidate();
		pendingTextSeal = false;
		pendingTextOrdinal = null;
		thinkingActive = false;
		thinkingText = "";
		thinkingTokenCount = 0;
		thinkingTokenCountExact = false;
		thinkingBlocks.clear();
		assistantThinkingStarted = false;
		return;
	}

	// No thinking or tools preceded this text, so there is no compact block to
	// seal. Do not let the boundary leak forward and close a later tool group.
	if (!thinkingText.trim()) {
		pendingTextSeal = false;
		pendingTextOrdinal = null;
	}
}

function maybeGroup(parent: Container, component: Component): void {
	const view = asToolView(component);
	if (!view || parent instanceof ToolGroupComponent) return;
	const children = parent.children;
	const index = children.indexOf(component);
	if (index < 0) return;
	const prior = previousGroupable(children, index - 1);

	// Previous sibling is an open (not-yet-sealed) group → join it.
	if (prior?.child instanceof ToolGroupComponent && !prior.child.sealed) {
		children.splice(index, 1);
		prior.child.addTool(view);
		lastActiveGroup = prior.child;
		return;
	}
	// Previous sibling is a bare tool → merge both into a new group.
	const priorView = prior ? asToolView(prior.child) : undefined;
	if (prior && priorView) {
		const group = new ToolGroupComponent();
		group.addTool(priorView);
		group.addTool(view);
		parent.children[prior.index] = group;
		children.splice(index, 1);
		groups.add(group);
		lastActiveGroup = group;
		return;
	}
	// Otherwise (sealed group before, or nothing groupable) → wrap the tool in a
	// fresh open group so it stays visible.
	const group = new ToolGroupComponent();
	group.addTool(view);
	parent.children[index] = group;
	groups.add(group);
	lastActiveGroup = group;
}

interface ContainerPatch {
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
}

interface PatchState {
	original: ContainerPatch;
	installed: ContainerPatch;
}

// AssistantMessageComponent content containers that may carry a "phantom" blank
// line. With hiddenThinkingLabel set to "", pi still adds
// Text(italic(fg("thinkingText",""))) to the message; because the empty string
// is wrapped in ANSI escapes, Text does not treat it as empty and renders a full
// blank line. That phantom line (plus the thinking-only Spacer pi adds after
// it) makes the gap between a folded tool group and the following text look too
// large. We strip the empty Text so only pi's normal single Spacer remains.
const assistantContentContainers = new WeakSet<Container>();
type AssistantContentState = {
	/** Sealed groups keyed by the visible Markdown block they precede. */
	anchors: Map<number, ToolGroupComponent>;
	/** Visible Markdown ordinal while AssistantMessageComponent rebuilds. */
	nextTextOrdinal: number;
	/** Turn-duration divider bound to the final visible Markdown ordinal. */
	finalDivider?: { ordinal: number; component: TurnDividerComponent };
};
const assistantContentStates = new WeakMap<Container, AssistantContentState>();
const groupAnchors = new WeakMap<ToolGroupComponent, { container: Container; ordinal: number }>();

function getAssistantContentState(container: Container): AssistantContentState {
	let state = assistantContentStates.get(container);
	if (!state) {
		state = { anchors: new Map(), nextTextOrdinal: 0 };
		assistantContentStates.set(container, state);
	}
	return state;
}

function removeGroupFromContainer(container: Container, group: ToolGroupComponent): void {
	const index = container.children.indexOf(group);
	if (index >= 0) container.children.splice(index, 1);
}

function removeComponentFromContainer(container: Container, component: Component): void {
	const index = container.children.indexOf(component);
	if (index >= 0) container.children.splice(index, 1);
}

function formatWorkedTime(elapsedMs: number): string {
	const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

// Static horizontal rule with the turn's elapsed time in the middle:
//   ──── worked for 0m 42s ────
class TurnDividerComponent implements Component {
	private readonly timeLabel: string;
	private readonly endLabel: string;

	constructor(timeLabel: string, endTime: Date) {
		this.timeLabel = timeLabel;
		this.endLabel = endTime.toTimeString().slice(0, 8);
	}

	render(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: ThemeColor, text: string): string => themeFg(theme, color, text);
		const middle = `worked for ${this.timeLabel} · ended ${this.endLabel}`;
		const avail = Math.max(6, width - middle.length - 2);
		const left = Math.floor(avail / 2);
		const right = avail - left;
		const dash = (n: number) => "─".repeat(Math.max(0, n));
		const line = `${fg("dim", dash(left))} ${fg("muted", middle)} ${fg("dim", dash(right))}`;
		return [truncateToWidth(line, Math.max(1, width))];
	}

	invalidate(): void {}
}

// Insert the turn divider directly before the final visible Markdown, keeping
// the anchored group's trailing Spacer as the gap: ... group, Spacer, divider,
// final text. Re-inserting is idempotent (the old instance is removed first).
function placeTurnDividerBeforeText(container: Container, target: Markdown, divider: TurnDividerComponent): void {
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;
	removeComponentFromContainer(container, divider);
	container.children.splice(targetIndex, 0, divider);
}

// Called at agent_end: bind a divider to the final visible text of the last
// assistant message so it survives cumulative rebuilds (like anchored groups).
function insertTurnDivider(elapsedMs: number): void {
	if (elapsedMs < 1000) return;
	let comp: AssistantMessageComponent | null = lastStreamingComp;
	if (!comp || !(comp instanceof AssistantMessageComponent)) {
		if (!lastChatContainer) return;
		const children = lastChatContainer.children;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof AssistantMessageComponent) {
				comp = child;
				break;
			}
		}
	}
	if (!comp) return;
	const contentContainer = assistantContentOf(comp);
	if (!contentContainer) return;

	const markdowns = contentContainer.children.filter(isVisibleTextMarkdown);
	if (markdowns.length === 0) return;
	const final = markdowns[markdowns.length - 1];
	if (!final) return;
	const finalIndex = contentContainer.children.indexOf(final);
	// Only separate the final text from preceding work (an anchored tool/thinking
	// group). A plain text-only answer gets no divider.
	const hasPriorContent = contentContainer.children
		.slice(0, finalIndex)
		.some((child) => child instanceof ToolGroupComponent);
	if (!hasPriorContent) return;

	const state = getAssistantContentState(contentContainer);
	if (state.finalDivider && contentContainer.children.includes(state.finalDivider.component)) return;
	const ordinal = markdowns.length - 1;
	const divider = new TurnDividerComponent(formatWorkedTime(elapsedMs), new Date());
	state.finalDivider = { ordinal, component: divider };
	placeTurnDividerBeforeText(contentContainer, final, divider);
	contentContainer.invalidate();
	capturedTui?.requestRender();
}

function isVisibleTextMarkdown(component: Component): component is Markdown {
	// Thinking Markdown receives a defaultTextStyle ({ color, italic }) from
	// AssistantMessageComponent; normal assistant text does not. Count only
	// normal text blocks so anchors remain correct if thinking visibility is
	// toggled on.
	return component instanceof Markdown && !hasDefaultTextStyle(component);
}

function placeAnchoredGroupBeforeText(container: Container, target: Markdown, group: ToolGroupComponent): void {
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;

	// Pi may accumulate one Spacer for the message itself plus one Spacer for
	// every hidden thinking run before this text. Tool loops can therefore leave
	// an arbitrarily large run here. Replace the entire run with a deterministic
	// boundary:
	//
	//   previous text/content -> one blank -> compact group -> one blank -> text
	//
	// This also makes repeated cumulative AssistantMessageComponent rebuilds
	// idempotent instead of accumulating more spacing around restored anchors.
	let spacerStart = targetIndex;
	while (spacerStart > 0 && container.children[spacerStart - 1] instanceof Spacer) spacerStart--;
	if (targetIndex > spacerStart) {
		container.children.splice(spacerStart, targetIndex - spacerStart);
	}
	group.anchored = true;
	container.children.splice(spacerStart, 0, new Spacer(1), group, new Spacer(1));
}

function insertAnchoredGroup(container: Container, ordinal: number, group: ToolGroupComponent): void {
	const markdowns = container.children.filter(isVisibleTextMarkdown);
	const target = markdowns[ordinal];
	if (!target) return;
	removeGroupFromContainer(container, group);
	placeAnchoredGroupBeforeText(container, target, group);
}

interface AssistantInternals {
	readonly contentContainer?: unknown;
	setExpanded?(expanded: boolean): void;
}

function assistantInternals(component: AssistantMessageComponent): AssistantInternals {
	return component as unknown as AssistantInternals;
}

function assistantContentOf(component: AssistantMessageComponent): Container | undefined {
	const container = assistantInternals(component).contentContainer;
	return container instanceof Container ? container : undefined;
}

function textOf(component: Text): string {
	const internals = component as unknown as { text?: unknown };
	return typeof internals.text === "string" ? internals.text : "";
}

function hasDefaultTextStyle(component: Markdown): boolean {
	return (component as unknown as { defaultTextStyle?: unknown }).defaultTextStyle !== undefined;
}

function installAssistantExpansion(component: AssistantMessageComponent, contentContainer: Container): void {
	// Ctrl+O only visits top-level chat children. Once compact groups are
	// anchored inside an AssistantMessageComponent, make that top-level
	// component expandable and delegate the state to its nested groups.
	assistantInternals(component).setExpanded = (expanded: boolean) => {
		const state = assistantContentStates.get(contentContainer);
		if (!state) return;
		for (const group of state.anchors.values()) group.setExpanded(expanded);
		contentContainer.invalidate();
	};
}

function anchorGroupBeforeCurrentText(group: ToolGroupComponent, ordinal: number): void {
	if (!lastStreamingComp || !lastChatContainer) return;
	const contentContainer = assistantContentOf(lastStreamingComp);
	if (!contentContainer) return;

	// An open group normally lives directly in the chat container. Remove it
	// there before nesting it at the exact text boundary.
	removeGroupFromContainer(lastChatContainer, group);

	const previousAnchor = groupAnchors.get(group);
	if (previousAnchor) {
		const previousState = assistantContentStates.get(previousAnchor.container);
		if (previousState?.anchors.get(previousAnchor.ordinal) === group) {
			previousState.anchors.delete(previousAnchor.ordinal);
		}
		removeGroupFromContainer(previousAnchor.container, group);
	}

	const state = getAssistantContentState(contentContainer);
	const replaced = state.anchors.get(ordinal);
	if (replaced && replaced !== group) {
		removeGroupFromContainer(contentContainer, replaced);
		replaced.anchored = false;
		groupAnchors.delete(replaced);
	}
	state.anchors.set(ordinal, group);
	groupAnchors.set(group, { container: contentContainer, ordinal });
	insertAnchoredGroup(contentContainer, ordinal, group);
	lastChatContainer.invalidate();
	capturedTui?.requestRender();
}

function restoreAssistantAnchor(parent: Component, component: Component): void {
	if (!(parent instanceof Container) || !assistantContentContainers.has(parent)) return;
	if (!isVisibleTextMarkdown(component)) return;
	installVisibleAssistantMarkdownRendering(component);
	const state = getAssistantContentState(parent);
	const ordinal = state.nextTextOrdinal++;
	const group = state.anchors.get(ordinal);
	if (group) {
		removeGroupFromContainer(parent, group);
		placeAnchoredGroupBeforeText(parent, component, group);
	}
	const divider = state.finalDivider;
	if (divider && divider.ordinal === ordinal) {
		placeTurnDividerBeforeText(parent, component, divider.component);
	}
}

function releaseAssistantAnchors(component: Component): void {
	if (!(component instanceof AssistantMessageComponent)) return;
	const contentContainer = assistantContentOf(component);
	if (!contentContainer) return;
	const state = assistantContentStates.get(contentContainer);
	if (!state) return;
	for (const group of state.anchors.values()) {
		groupAnchors.delete(group);
		groups.delete(group);
	}
	state.anchors.clear();
	state.finalDivider = undefined;
}

function stripAssistantPhantomPadding(parent: Component, component: Component): void {
	// Mark the plain Container that an AssistantMessageComponent owns as its
	// content container so we can trim its children later.
	if (
		parent instanceof AssistantMessageComponent &&
		component instanceof Container &&
		!(component instanceof AssistantMessageComponent)
	) {
		assistantContentContainers.add(component);
		getAssistantContentState(component);
		installAssistantExpansion(parent, component);
		return;
	}
	if (!(parent instanceof Container) || !assistantContentContainers.has(parent)) return;
	// Drop any Text child whose visible content is empty (only ANSI styling).
	// This is the hidden-thinking label pi renders even when the label is "".
	// Also remove the trailing Spacer run that preceded the label. Otherwise
	// every thinking-only assistant message in a multi-tool loop remains as a
	// one-line blank component; moving the final group into a later text message
	// then exposes all of those accumulated blank lines as a huge gap.
	if (component instanceof Text) {
		const visible = stripTerminalSequences(textOf(component)).trim();
		if (visible === "") {
			const index = parent.children.indexOf(component);
			if (index >= 0) parent.children.splice(index, 1);
			while (parent.children.at(-1) instanceof Spacer) parent.children.pop();
		}
	}
}

function installGrouping(): void {
	const host = globalThis as unknown as Record<symbol, PatchState | undefined>;
	const prototype = Container.prototype;
	const previous = host[PATCH_KEY];
	// Always (re-)install. On hot-reload (/reload) the old instance's prototype
	// patch stays on Container.prototype but its closures reference the OLD
	// module state (groups/lastActiveGroup). Skipping here would leave the new
	// instance's event handlers reading a different lastActiveGroup than the one
	// the patch writes, so message-boundary sealing would never fire. Re-install
	// with the preserved original so future addChild calls use THIS instance's
	// closures.

	const original: ContainerPatch = {
		addChild:
			previous && prototype.addChild === previous.installed.addChild ? previous.original.addChild : prototype.addChild,
		removeChild:
			previous && prototype.removeChild === previous.installed.removeChild
				? previous.original.removeChild
				: prototype.removeChild,
		clear: previous && prototype.clear === previous.installed.clear ? previous.original.clear : prototype.clear,
	};

	function patchedAddChild(this: Container, component: Component): void {
		original.addChild.call(this, component);
		// Remember where the current assistant message component lives so a
		// thinking-only group can be inserted right after it later.
		if (component instanceof AssistantMessageComponent) {
			lastChatContainer = this;
			lastStreamingComp = component;
			flushPendingTextSeal();
		}
		maybeGroup(this, component);
		stripAssistantPhantomPadding(this, component);
		restoreAssistantAnchor(this, component);
	}

	function patchedRemoveChild(this: Container, component: Component): void {
		releaseAssistantAnchors(component);
		original.removeChild.call(this, component);
	}

	function patchedClear(this: Container): void {
		if (assistantContentContainers.has(this)) {
			// AssistantMessageComponent rebuilds this container for every
			// cumulative stream update. Keep sealed compact groups in the
			// anchor map; restoreAssistantAnchor() reinserts each one before
			// its matching Markdown child as the rebuild proceeds.
			getAssistantContentState(this).nextTextOrdinal = 0;
			original.clear.call(this);
			return;
		}
		for (const child of [...this.children]) {
			if (child instanceof ToolGroupComponent) groups.delete(child);
			releaseAssistantAnchors(child);
		}
		original.clear.call(this);
	}

	const installed: ContainerPatch = {
		addChild: patchedAddChild,
		removeChild: patchedRemoveChild,
		clear: patchedClear,
	};
	prototype.addChild = installed.addChild;
	prototype.removeChild = installed.removeChild;
	prototype.clear = installed.clear;
	host[PATCH_KEY] = { original, installed };
}

// =============================================================================
// Built-in tool delegation (render nothing natively)
// =============================================================================
type ToolName = "read" | "bash" | "edit" | "write" | "find" | "grep" | "ls";

interface DelegatedTool {
	readonly parameters: TSchema;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>>;
}

function eraseToolType(tool: object): DelegatedTool {
	return tool as DelegatedTool;
}

const toolCache = new Map<string, Record<ToolName, DelegatedTool>>();
function getTools(cwd: string): Record<ToolName, DelegatedTool> {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = {
			read: eraseToolType(createReadTool(cwd)),
			bash: eraseToolType(createBashTool(cwd)),
			edit: eraseToolType(createEditTool(cwd)),
			write: eraseToolType(createWriteTool(cwd)),
			find: eraseToolType(createFindTool(cwd)),
			grep: eraseToolType(createGrepTool(cwd)),
			ls: eraseToolType(createLsTool(cwd)),
		};
		toolCache.set(cwd, tools);
	}
	return tools;
}

export default function (pi: ExtensionAPI) {
	installGrouping();
	installCompactionSummaryRendering();

	const delegate =
		(name: ToolName) =>
		async (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			return getTools(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate);
		};

	for (const name of ["read", "bash", "edit", "write", "find", "grep", "ls"] as const) {
		pi.registerTool({
			name,
			label: name,
			description: `Built-in ${name} (rendering handled by compact-ui group).`,
			parameters: getTools(process.cwd())[name].parameters,
			execute: delegate(name),
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		currentTheme = ctx.ui.theme;
		ctx.ui.setHiddenThinkingLabel("");
		// Capture the TUI instance via setWidget's factory so the animation can
		// call its throttled requestRender() to repaint just the changed cells.
		ctx.ui.setWidget("compact-anim", (tui) => {
			capturedTui = tui;
			return { render: (): string[] => [], invalidate(): void {} };
		});
		installGrouping();
		installCompactionSummaryRendering();
	});

	pi.on("tool_execution_start", async (event) => {
		toolStarts.set(event.toolCallId, Date.now());
		lastActiveGroup?.invalidate();
	});

	pi.on("tool_execution_end", async (event) => {
		for (const group of groups) {
			for (const child of group.children) {
				const view = asToolView(child);
				if (view?.toolCallId === event.toolCallId) toolEndAts.set(view.toolCallId, Date.now());
			}
		}
		lastActiveGroup?.invalidate();
	});

	pi.on("message_start", async (event) => {
		const role = event.message.role;
		// A new user message is a hard turn boundary: seal whatever block is still
		// open. Assistant/toolResult message boundaries do NOT seal — thinking and
		// tool calls stay in one block until real (non-thinking) text appears.
		if (role === "user" && lastActiveGroup && !lastActiveGroup.sealed) {
			lastActiveGroup.sealed = true;
			lastActiveGroup.thinkingFrozen = thinkingText;
			lastActiveGroup.thinkingTokensFrozen = thinkingTokenCount;
			lastActiveGroup.thinkingTokensFrozenExact = thinkingTokenCountExact;
		}
		if (role === "user") {
			turnStartMs = Date.now();
			thinkingActive = false;
			thinkingText = "";
			thinkingTokenCount = 0;
			thinkingTokenCountExact = false;
			handledTextIndexes.clear();
			thinkingBlocks.clear();
			assistantThinkingStarted = false;
			pendingTextSeal = false;
			pendingTextOrdinal = null;
			lastStreamingComp = null;
		} else if (role === "assistant") {
			// contentIndex values are local to one streamed assistant message.
			// Keep the previous thinking snapshot until this message either starts
			// new thinking or emits text that seals the open tool group.
			handledTextIndexes.clear();
			assistantThinkingStarted = false;
			thinkingActive = false;
			pendingTextSeal = false;
			pendingTextOrdinal = null;
			// Do not insert early thinking beside the previous assistant message.
			// The addChild patch fills this with the current streaming component.
			lastStreamingComp = null;
		}
	});

	pi.on("message_update", async (event) => {
		const msg = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
		if (!msg) return;
		const streamEvent = event.assistantMessageEvent;

		if (
			streamEvent.type === "thinking_start" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "thinking_end"
		) {
			// Only read the block targeted by this stream event. The surrounding
			// message is cumulative and may still contain thinking from before a
			// text boundary; scanning all content would resurrect that old block.
			if (!assistantThinkingStarted) {
				thinkingBlocks.clear();
				assistantThinkingStarted = true;
			}
			const block = msg.content[streamEvent.contentIndex];
			const blockText =
				block?.type === "thinking" ? block.thinking : streamEvent.type === "thinking_end" ? streamEvent.content : "";
			thinkingBlocks.set(streamEvent.contentIndex, blockText);
			thinkingText = [...thinkingBlocks.values()].filter((text) => text.trim()).join("\n\n");
			updateThinkingTokenCount(msg);
			thinkingActive = streamEvent.type !== "thinking_end";
			// Show a collapsed block as soon as thinking appears (no tool needed).
			ensureThinkingGroup();
		} else if (
			streamEvent.type === "text_start" ||
			streamEvent.type === "text_delta" ||
			streamEvent.type === "text_end"
		) {
			const block = msg.content[streamEvent.contentIndex];
			const text = block?.type === "text" ? block.text.trim() : "";
			// The first non-whitespace text is a boundary. Deduplicate by content
			// index so every later cumulative delta extends the same text block.
			if (text.length > 0 && !handledTextIndexes.has(streamEvent.contentIndex)) {
				if (thinkingText.trim()) updateThinkingTokenCount(msg);
				handledTextIndexes.add(streamEvent.contentIndex);
				pendingTextSeal = true;
				pendingTextOrdinal =
					msg.content.slice(0, streamEvent.contentIndex + 1).filter((item) => item.type === "text" && item.text.trim())
						.length - 1;
				flushPendingTextSeal();
			}
		} else if (streamEvent.type === "done" || streamEvent.type === "error") {
			if (thinkingText.trim()) updateThinkingTokenCount(msg);
			thinkingActive = false;
		}

		// Refresh the active block when thinking starts/stops (event-driven only;
		// no timer, so the transcript scroll position is never yanked around).
		lastActiveGroup?.invalidate();
	});

	pi.on("agent_end", async () => {
		// Turn finished: freeze the final block so it stops spinning and shows a
		// stable summary until the user starts the next turn.
		if (lastActiveGroup && !lastActiveGroup.sealed) {
			lastActiveGroup.sealed = true;
			lastActiveGroup.thinkingFrozen = thinkingText;
			lastActiveGroup.thinkingTokensFrozen = thinkingTokenCount;
			lastActiveGroup.thinkingTokensFrozenExact = thinkingTokenCountExact;
		}
		// Separate the final visible text from the preceding work with a divider
		// that reports how long this turn ran.
		const elapsedMs = Date.now() - turnStartMs;
		insertTurnDivider(elapsedMs);
		thinkingActive = false;
		thinkingText = "";
		thinkingTokenCount = 0;
		thinkingTokenCountExact = false;
		handledTextIndexes.clear();
		thinkingBlocks.clear();
		assistantThinkingStarted = false;
		pendingTextSeal = false;
		pendingTextOrdinal = null;
	});

	pi.registerCommand("compact-ui-config", {
		description: "Interactive compact-ui settings (arrows to select, Enter to adjust, Esc to close)",
		handler: async (_args, ctx) => {
			// Non-TUI modes (print/json) can't show the interactive menu.
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`compact: collapsedMaxLines=${config.collapsedMaxLines}, expandedToolLines=${config.expandedToolLines}, expandedThinkingLines=${config.expandedThinkingLines}`,
					"info",
				);
				return;
			}

			const changed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
				let anyChanged = false;
				const items: SettingItem[] = CONFIG_KEYS.map((meta) => ({
					id: meta.id,
					label: meta.label,
					currentValue: String(config[meta.id]),
					description: meta.description,
					submenu: (currentValue: string, subDone: (value?: string) => void) =>
						makeStepper(meta.label, Number(currentValue), meta, theme, subDone),
				}));
				const settingsList = new SettingsList(
					items,
					Math.min(items.length, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Persist and refresh the live groups when SettingsList commits a change.
						if (isConfigKey(id)) {
							config[id] = Number(newValue);
							saveConfig();
							anyChanged = true;
							for (const group of groups) group.invalidate();
						}
					},
					() => done(anyChanged),
				);
				return {
					render(width: number) {
						return settingsList.render(width);
					},
					invalidate() {
						settingsList.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (changed) {
				ctx.ui.notify("compact-ui settings saved", "info");
			}
		},
	});
}
