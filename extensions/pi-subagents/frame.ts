import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Subset of the host theme used for drawing; see `pi-background-tasks/ui.ts` for the same convention. */
export interface FrameTheme {
	fg(color: "accent" | "border", text: string): string;
	bold(text: string): string;
}

/** Rows spent on the top and bottom borders. */
export const BORDER_ROWS = 2;

/** Columns spent on the side borders and their inner spacing. */
const SIDE_COLUMNS = 4;

/**
 * Rendered messages and tool output may leave colours open, so styling is closed
 * before the padding instead of bleeding into it and the border.
 */
const RESET = "\x1b[0m";

export function innerWidth(width: number): number {
	return Math.max(1, width - SIDE_COLUMNS);
}

/**
 * Take the tail of `lines` that fits in `rows`, offset by `scroll` lines from
 * the bottom. The result always has exactly `rows` lines so the surrounding box
 * keeps a fixed size, and the clamped offset is returned for the caller to keep.
 */
export function viewport(lines: readonly string[], rows: number, scroll: number): { lines: string[]; scroll: number } {
	if (rows <= 0) return { lines: [], scroll: 0 };
	const clamped = Math.max(0, Math.min(scroll, Math.max(0, lines.length - rows)));
	const end = lines.length - clamped;
	const visible = lines.slice(Math.max(0, end - rows), end);
	return { lines: [...visible, ...new Array<string>(rows - visible.length).fill("")], scroll: clamped };
}

/** Draw `lines` inside a box with `title` set into the top border. */
export function frame(lines: readonly string[], width: number, theme: FrameTheme, title: string): string[] {
	if (width < 5) return lines.map((line) => truncateToWidth(line, width));
	const inner = width - 2;
	const content = innerWidth(width);
	const label = truncateToWidth(` ${title} `, inner);
	const topFill = "─".repeat(Math.max(0, inner - visibleWidth(label)));
	const side = theme.fg("border", "│");
	return [
		`${theme.fg("border", "╭")}${theme.fg("accent", theme.bold(label))}${theme.fg("border", `${topFill}╮`)}`,
		...lines.map((line) => `${side} ${pad(line, content)} ${side}`),
		theme.fg("border", `╰${"─".repeat(inner)}╯`),
	];
}

function pad(text: string, width: number): string {
	// A terminal advances a tab to its own stop, which would push the right border
	// out of the box, so tabs are expanded to the width Pi measures them at.
	return truncateToWidth(`${text.replaceAll("\t", "   ")}${RESET}`, width, "", true);
}
