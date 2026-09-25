import { getLanguageFromPath, highlightCode, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_NUMBER_WIDTH = 3;

type CodeLineKind = "added" | "removed" | "context";

interface CodeLine {
	kind: CodeLineKind;
	sign: string;
	number: string;
	code: string;
	codeColor?: ThemeColor;
}

const GUTTER_COLOR: Record<CodeLineKind, ThemeColor> = {
	added: "toolDiffAdded",
	removed: "toolDiffRemoved",
	context: "toolDiffContext",
};

export function countChangedLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function wrapCodeLine(prefix: string, code: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const codeWidth = visibleWidth(code);
	if (prefixWidth + codeWidth <= width) return [`${prefix}${code}`];
	if (width - prefixWidth < 1) return [truncateToWidth(`${prefix}${code}`, width, "")];
	const chunkWidth = width - prefixWidth;
	const indent = " ".repeat(prefixWidth);
	const out: string[] = [];
	let col = 0;
	while (col < codeWidth) {
		const chunk = sliceByColumn(code, col, chunkWidth, true);
		const chunkColumns = visibleWidth(chunk);
		if (chunkColumns <= 0) break;
		out.push(`${out.length === 0 ? prefix : indent}${chunk}`);
		col += chunkColumns;
	}
	return out.length > 0 ? out : [`${prefix}${truncateToWidth(code, chunkWidth, "")}`];
}

function displayLines(codes: readonly string[]): string[] {
	return codes.map((code) => code.replace(/\r/gu, "").replace(/\t/gu, "   "));
}

function highlightLines(display: readonly string[], path: string): string[] {
	const lang = path ? getLanguageFromPath(path) : undefined;
	if (!lang) return [...display];
	const highlighted = highlightCode(display.join("\n"), lang);
	return display.map((code, index) => highlighted[index] ?? code);
}

function diffGutterWidth(lines: readonly string[]): number {
	for (const line of lines) {
		const match = /^[-+ ] *\d+ /.exec(line);
		if (match) return match[0].length;
	}
	return 0;
}

function diffCodeLines(diff: string, path: string): CodeLine[] {
	const lines = diff.split("\n");
	const gutterWidth = diffGutterWidth(lines);
	const display = displayLines(lines.map((line) => line.slice(gutterWidth)));
	const highlighted = highlightLines(display, path);
	let numberWidth = MIN_NUMBER_WIDTH;
	for (const line of lines) {
		const digits = /^[-+ ] *(\d+)/.exec(line)?.[1];
		if (digits) numberWidth = Math.max(numberWidth, digits.length);
	}
	return lines.map((line, index) => {
		const sign = line.slice(0, 1);
		const rawNumber = line.slice(1, Math.max(1, gutterWidth - 1));
		const digits = /\d/.test(rawNumber) ? rawNumber.trim() : "";
		const number = digits.padStart(numberWidth, " ");
		const plain = display[index] ?? "";
		if (!digits) return { kind: "context", sign, number, code: plain, codeColor: "muted" };
		if (sign === "-") return { kind: "removed", sign, number, code: plain, codeColor: "toolDiffRemoved" };
		return { kind: sign === "+" ? "added" : "context", sign, number, code: highlighted[index] ?? plain };
	});
}

export function renderDiffRows(diff: string, path: string, width: number, theme: Theme): string[] {
	const pad = (line: string) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	const out: string[] = [];
	for (const line of diffCodeLines(diff, path)) {
		const sign = theme.fg(GUTTER_COLOR[line.kind], line.sign);
		const number = theme.fg("thinkingText", ` ${line.number} `);
		const code = line.codeColor ? theme.fg(line.codeColor, line.code) : line.code;
		for (const wrapped of wrapCodeLine(`${sign}${number}`, code, width)) {
			const padded = pad(wrapped);
			if (line.kind === "added") out.push(theme.bg("toolSuccessBg", padded));
			else if (line.kind === "removed") out.push(theme.bg("toolErrorBg", padded));
			else out.push(padded);
		}
	}
	return out;
}
