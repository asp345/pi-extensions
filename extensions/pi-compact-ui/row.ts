import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { handoffTaskId } from "../pi-background-tasks/events.ts";
import { fileChangesOf } from "../pi-bash-diff/details.ts";
import { formatDuration } from "../shared/format.ts";
import { countChangedLines, renderDiffRows } from "./diff.ts";

export const RUNNING_REFRESH_MS = 1000;

const INPUT_PREFIX = "╰─ ";
const OUTPUT_PREFIX = " › ";
const INDENT = "   ";
const DIFF_SUMMARY_PREFIX = "    ╰─ ";
const PREVIEW_ROWS = 20;

export interface ToolRowState {
	name: string;
	args: unknown;
	cwd: string;
	expanded: boolean;
	executionStarted: boolean;
	isPartial: boolean;
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: unknown;
	};
	startedAt?: number;
	endedAt?: number;
}

type ToolRowStatus = "queued" | "running" | "background" | "done" | "error";

interface DiffBlock {
	path: string;
	diff: string;
	showRemoved: boolean;
}

export function rowStatus(row: ToolRowState): ToolRowStatus {
	if (row.result?.isError) return "error";
	if (row.result && !row.isPartial) return handoffTaskId(row.result.details) ? "background" : "done";
	if (row.executionStarted) return "running";
	return "queued";
}

function firstString(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() ? value : undefined;
	const items = Array.isArray(value) ? value : typeof value === "object" && value !== null ? Object.values(value) : [];
	for (const item of items) {
		const found = firstString(item);
		if (found !== undefined) return found;
	}
	return undefined;
}

function fit(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	return `${sliceByColumn(text, 0, Math.max(0, width - 1), true)}…`;
}

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function plain(value: string): string {
	return stripVTControlCharacters(value).replace(/\r/gu, "").replace(/\t/gu, INDENT);
}

function outputText(row: ToolRowState): string {
	const text = (row.result?.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
	return plain(text).trimEnd();
}

function diffOf(row: ToolRowState): string | undefined {
	if (!row.result || row.result.isError) return undefined;
	const details = row.result.details;
	if (typeof details !== "object" || details === null) return undefined;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" && diff ? diff : undefined;
}

function writtenDiff(row: ToolRowState): string | undefined {
	if (row.name !== "write" || rowStatus(row) !== "done") return undefined;
	const content =
		typeof row.args === "object" && row.args !== null ? (row.args as { content?: unknown }).content : undefined;
	if (typeof content !== "string" || !content) return undefined;
	const lines = content.replace(/\n$/u, "").split("\n");
	const numberWidth = String(lines.length).length;
	return lines.map((line, index) => `+${String(index + 1).padStart(numberWidth)} ${line}`).join("\n");
}

function previewDiff(row: ToolRowState): string | undefined {
	return diffOf(row) ?? writtenDiff(row);
}

function fileChangeBlocks(row: ToolRowState): DiffBlock[] {
	return fileChangesOf(row.result?.details).map((change) => ({ ...change, showRemoved: true }));
}

function previewBlocks(row: ToolRowState): DiffBlock[] {
	const path = argPath(row.args);
	const diff = diffOf(row);
	if (diff) return [{ path, diff, showRemoved: true }];
	const written = writtenDiff(row);
	if (written) return [{ path, diff: written, showRemoved: false }];
	return fileChangeBlocks(row);
}

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function argPath(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" ? path : "";
}

function marker(status: ToolRowStatus, theme: Theme): string {
	switch (status) {
		case "error":
			return theme.fg("error", "✗");
		case "done":
			return theme.fg("success", "✓");
		case "background":
			return theme.fg("accent", "↗");
		case "running":
			return theme.fg("bashMode", "◈");
		case "queued":
			return theme.fg("muted", "◇");
	}
}

function headerLine(row: ToolRowState, theme: Theme, width: number, now: number): string {
	const status = rowStatus(row);
	const separator = theme.fg("dim", " · ");
	const head = ` ${marker(status, theme)} ${theme.fg("muted", row.name)}`;
	const tail: string[] = [];
	const output = outputText(row);
	if ((status === "done" || status === "error") && output && !previewDiff(row)) {
		tail.push(theme.fg("dim", `↓ ${output.split("\n").length} lines`));
	}
	const backgroundTaskId = status === "background" ? handoffTaskId(row.result?.details) : undefined;
	if (backgroundTaskId) tail.push(theme.fg("accent", backgroundTaskId));
	if (row.startedAt !== undefined) {
		tail.push(theme.fg("dim", formatDuration((row.endedAt ?? now) - row.startedAt)));
	}
	if (status === "error") tail.push(theme.fg("error", "error"));
	const suffix = tail.map((part) => `${separator}${part}`).join("");
	const preview = oneLine(plain(firstString(row.args) ?? ""));
	const available = width - 1 - visibleWidth(head) - visibleWidth(suffix) - visibleWidth(separator);
	if (!preview || available < 2) return truncateToWidth(`${head}${suffix}`, width, "");
	return `${head}${separator}${theme.fg("dim", fit(preview, available))}${suffix}`;
}

function diffCounts(block: DiffBlock, theme: Theme): string {
	const { added, removed } = countChangedLines(block.diff);
	const removedCount = block.showRemoved ? ` ${theme.fg("toolDiffRemoved", `-${removed}`)}` : "";
	return ` ${theme.fg("toolDiffAdded", `+${added}`)}${removedCount}`;
}

function diffSummaryLine(row: ToolRowState, block: DiffBlock, theme: Theme, width: number): string {
	const prefix = theme.fg("dim", DIFF_SUMMARY_PREFIX);
	const counts = diffCounts(block, theme);
	const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(counts));
	const path = fit(displayPath(block.path, row.cwd), available);
	return truncateToWidth(`${prefix}${theme.fg("muted", path)}${counts}`, width, "");
}

function wrapBlock(
	lines: string[],
	text: string,
	firstPrefix: string,
	color: (text: string) => string,
	theme: Theme,
	width: number,
	pending: { first: boolean },
): void {
	const available = Math.max(1, width - 1 - visibleWidth(firstPrefix));
	for (const sourceLine of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(sourceLine, available);
		for (const line of wrapped.length > 0 ? wrapped : [""]) {
			const prefix = pending.first ? theme.fg("dim", firstPrefix) : INDENT;
			pending.first = false;
			lines.push(truncateToWidth(` ${prefix}${color(line || " ")}`, width, ""));
		}
	}
}

function argEntries(args: unknown): Array<[string, string]> {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return args === undefined ? [] : [["", JSON.stringify(args) ?? ""]];
	}
	return Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}

function renderArgs(lines: string[], row: ToolRowState, theme: Theme, width: number): boolean {
	const entries = argEntries(row.args);
	if (entries.length === 0) return false;
	const pending = { first: true };
	for (const [key, value] of entries) {
		const text = `${key ? `${key}: ` : ""}${plain(value ?? "")}`;
		wrapBlock(lines, text, INPUT_PREFIX, (line) => theme.fg("muted", line), theme, width, pending);
	}
	return true;
}

function renderOutput(lines: string[], row: ToolRowState, theme: Theme, width: number): void {
	const status = rowStatus(row);
	const output = outputText(row);
	const pending = { first: true };
	if (output) {
		const color = status === "error" ? "muted" : "toolOutput";
		wrapBlock(lines, output, OUTPUT_PREFIX, (text) => theme.fg(color, text), theme, width, pending);
		return;
	}
	const note = status === "running" || status === "queued" ? "waiting for output..." : "no output";
	wrapBlock(lines, note, OUTPUT_PREFIX, (text) => theme.fg("muted", text), theme, width, pending);
}

function diffRows(block: DiffBlock, theme: Theme, width: number): string[] {
	const contentWidth = Math.max(1, width - 1);
	return renderDiffRows(block.diff, block.path, contentWidth, theme).map((diffRow) =>
		truncateToWidth(` ${diffRow}`, width, ""),
	);
}

function renderBlocks(
	lines: string[],
	row: ToolRowState,
	blocks: DiffBlock[],
	theme: Theme,
	width: number,
	limit: number,
): void {
	for (const block of blocks) {
		lines.push(diffSummaryLine(row, block, theme, width));
		const rows = diffRows(block, theme, width);
		const shown = Math.min(rows.length, limit);
		lines.push(...rows.slice(0, shown));
		if (rows.length > shown) {
			lines.push(truncateToWidth(` ${theme.fg("dim", `${INDENT}… ${rows.length - shown} more lines`)}`, width, ""));
		}
	}
}

export function renderToolRow(row: ToolRowState, theme: Theme, width: number, now: number): string[] {
	const lines = [headerLine(row, theme, width, now)];
	if (!row.expanded) {
		renderBlocks(lines, row, previewBlocks(row), theme, width, PREVIEW_ROWS);
		return lines;
	}
	const hasArgs = renderArgs(lines, row, theme, width);
	if (hasArgs) lines.push("");
	const diff = diffOf(row);
	if (diff) {
		renderBlocks(lines, row, [{ path: argPath(row.args), diff, showRemoved: true }], theme, width, Infinity);
		return lines;
	}
	renderOutput(lines, row, theme, width);
	const changes = fileChangeBlocks(row);
	if (changes.length > 0) {
		lines.push("");
		renderBlocks(lines, row, changes, theme, width, Infinity);
	}
	return lines;
}
