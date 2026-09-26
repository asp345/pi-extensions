import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function fitLine(line: string, width: number, theme: Theme): string {
	if (visibleWidth(line) <= width) return line;
	return `${truncateToWidth(line, Math.max(0, width - 1), "")}${theme.fg("dim", "…")}`;
}

export function cell(text: string, width: number): string {
	const value = truncateToWidth(text, width, "");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function cellEnd(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

export function highlight(line: string, width: number, theme: Theme): string {
	return cell(line, width)
		.split("\x1b[0m")
		.map((segment) => theme.bg("selectedBg", segment))
		.join("\x1b[0m");
}

export function frame(lines: string[], width: number, theme: Theme, title: string): string[] {
	const inner = Math.max(1, width - 2);
	const label = theme.fg("accent", theme.bold(` ${title} `));
	const fill = "─".repeat(Math.max(0, inner - 1 - visibleWidth(label)));
	return [
		truncateToWidth(`${theme.fg("border", "╭─")}${label}${theme.fg("border", `${fill}╮`)}`, width, ""),
		...lines.map((line) => `${theme.fg("border", "│")}${cell(` ${line}`, inner)}${theme.fg("border", "│")}`),
		theme.fg("border", `╰${"─".repeat(inner)}╯`),
	];
}

export interface Column {
	width: number;
	alignEnd?: boolean;
}

export function tableRow(values: string[], columns: Column[]): string {
	return columns
		.map((column, index) => ({ column, value: values[index] ?? "" }))
		.filter(({ column }) => column.width > 0)
		.map(({ column, value }) => (column.alignEnd ? cellEnd(value, column.width) : cell(value, column.width)))
		.join("  ");
}

export function listSelection<T extends { id: string }>(items: () => T[], initialId?: string) {
	let selectedId = initialId;
	const selected = (): T | undefined => {
		const list = items();
		const item = list.find((entry) => entry.id === selectedId) ?? list[0];
		selectedId = item?.id;
		return item;
	};
	const move = (delta: number): void => {
		const list = items();
		const index = list.findIndex((entry) => entry.id === selected()?.id);
		selectedId = list[Math.max(0, Math.min(list.length - 1, index + delta))]?.id;
	};
	return { selected, move };
}

export class StatusLineWidget {
	private requestRender?: () => void;
	private mounted = false;

	constructor(
		private readonly key: string,
		private readonly line: (theme: Theme) => string,
	) {}

	update(ctx: ExtensionContext, visible: boolean): void {
		if (!visible) {
			if (this.mounted) this.clear(ctx);
			return;
		}
		if (this.mounted) {
			this.requestRender?.();
			return;
		}
		this.mounted = true;
		ctx.ui.setWidget(
			this.key,
			(tui, theme) => {
				this.requestRender = () => tui.requestRender();
				return {
					render: (width: number) => [fitLine(this.line(theme), width, theme)],
					invalidate() {},
					dispose: () => {
						this.requestRender = undefined;
						this.mounted = false;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	clear(ctx: ExtensionContext): void {
		ctx.ui.setWidget(this.key, undefined);
		this.requestRender = undefined;
		this.mounted = false;
	}
}

export interface MessageEntry {
	marker: string;
	label: string;
	meta: string[];
	body?: string;
}

export class MessageLines implements Component {
	constructor(
		private readonly entries: MessageEntry[],
		private readonly bodyColor: ThemeColor,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		for (const entry of this.entries) {
			const head = [
				`${entry.marker} ${theme.fg("muted", entry.label)}`,
				...entry.meta.map((part) => theme.fg("dim", part)),
			];
			lines.push(fitLine(` ${head.join(theme.fg("dim", " · "))}`, width, theme));
			if (!entry.body) continue;
			const textWidth = Math.max(1, width - 4);
			const wrapped = entry.body.split("\n").flatMap((line) => {
				const parts = wrapTextWithAnsi(line, textWidth);
				return parts.length > 0 ? parts : [""];
			});
			wrapped.forEach((line, index) => {
				const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
				lines.push(truncateToWidth(` ${prefix}${theme.fg(this.bodyColor, line)}`, width, ""));
			});
		}
		return lines;
	}

	invalidate(): void {}
}
