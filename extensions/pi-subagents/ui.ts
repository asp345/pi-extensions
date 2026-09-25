import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { preview } from "./delegation.ts";
import type { SubagentManager } from "./manager.ts";
import { type AgentRecord, type AgentStatus, agentStatus } from "./types.ts";

export const COMMAND = "agents";
export const SHORTCUT = "ctrl+shift+s";
const WIDGET = "pi-subagents";
const REFRESH_MS = 1000;
const STATUS_ROW_ICON = "•";
const SECTIONS: readonly AgentStatus[] = ["running", "idle", "inactive"];
const SECTION_TITLES: Record<AgentStatus, string> = { running: "Running", idle: "Idle", inactive: "Inactive" };
const DETAIL_LINES = 6;

interface Counts {
	running: number;
	idle: number;
	inactive: number;
}

function countStatuses(records: readonly AgentRecord[]): Counts {
	const counts: Counts = { running: 0, idle: 0, inactive: 0 };
	for (const record of records) counts[agentStatus(record)] += 1;
	return counts;
}

function countsText(counts: Counts, theme: Theme): string {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(theme.fg("success", `● ${counts.running} running`));
	if (counts.idle > 0) parts.push(theme.fg("warning", `◐ ${counts.idle} idle`));
	if (counts.inactive > 0) parts.push(theme.fg("dim", `○ ${counts.inactive} inactive`));
	return parts.join("  ");
}

export function fitLine(line: string, width: number, theme: Theme): string {
	if (visibleWidth(line) <= width) return line;
	return `${truncateToWidth(line, Math.max(0, width - 1), "")}${theme.fg("dim", "…")}`;
}

function cell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function cellEnd(value: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

function age(since: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function modelLabel(record: AgentRecord): string {
	if (!record.model) return "-";
	const bare = record.model.slice(record.model.lastIndexOf("/") + 1) || record.model;
	return record.thinking && record.thinking !== "off" ? `${bare}:${record.thinking}` : bare;
}

function activityLabel(record: AgentRecord, now: number): string {
	if (record.running) return `${record.activity ?? "Waiting"} · ${age(record.runStartedAt ?? now, now)}`;
	if (record.lastError) return `error: ${record.lastError}`;
	return preview(record.lastText) ?? "";
}

function rowIcon(status: AgentStatus, theme: Theme): string {
	if (status === "running") {
		return theme.bold("◈");
	}
	return theme.bold(theme.fg(status === "idle" ? "warning" : "dim", STATUS_ROW_ICON));
}

function highlight(line: string, width: number, theme: Theme): string {
	const padded = cell(line, width);
	return padded
		.split("\x1b[0m")
		.map((segment) => theme.bg("selectedBg", segment))
		.join("\x1b[0m");
}

function frame(lines: string[], width: number, theme: Theme, title: string): string[] {
	const inner = Math.max(1, width - 2);
	const label = theme.fg("accent", theme.bold(` ${title} `));
	const fill = "─".repeat(Math.max(0, inner - 1 - visibleWidth(label)));
	return [
		truncateToWidth(`${theme.fg("border", "╭─")}${label}${theme.fg("border", `${fill}╮`)}`, width, ""),
		...lines.map((line) => `${theme.fg("border", "│")}${cell(` ${line}`, inner)}${theme.fg("border", "│")}`),
		theme.fg("border", `╰${"─".repeat(inner)}╯`),
	];
}

interface Layout {
	name: number;
	model: number;
	activity: number;
	cost: number;
	age: number;
}

function layout(records: readonly AgentRecord[], width: number, now: number): Layout {
	const cost = records.reduce((size, record) => Math.max(size, `$${record.cost.toFixed(2)}`.length), 4);
	const ageWidth = records.reduce((size, record) => Math.max(size, age(record.createdAt, now).length), 3);
	const available = Math.max(0, width - cost - ageWidth - 4);
	const desiredModel = records.reduce((size, record) => Math.max(size, visibleWidth(modelLabel(record))), 5);
	const model = Math.min(desiredModel, 32, Math.max(0, available - 12));
	const name = Math.min(28, Math.max(0, available - model - 2));
	const activity = Math.max(0, available - model - name - 4);
	return { name, model, activity, cost, age: ageWidth };
}

function tableRow(columns: string[], widths: Layout): string {
	const [name = "", model = "", activity = "", cost = "", ageText = ""] = columns;
	const cells = [cell(name, widths.name), cell(model, widths.model)];
	if (widths.activity > 0) cells.push(cell(activity, widths.activity));
	cells.push(`${cellEnd(cost, widths.cost)}  ${cellEnd(ageText, widths.age)}`);
	return cells.join("  ");
}

interface WidgetTui {
	requestRender(force?: boolean): void;
}

export class AgentsUI {
	private context?: ExtensionContext;
	private widgetTui?: WidgetTui;
	private mounted = false;

	constructor(private readonly manager: SubagentManager) {}

	attach(ctx: ExtensionContext): void {
		this.context = ctx;
		this.update();
	}

	detach(): void {
		this.context?.ui.setWidget(WIDGET, undefined);
		this.context = undefined;
		this.widgetTui = undefined;
		this.mounted = false;
	}

	update(): void {
		const ctx = this.context;
		if (!ctx?.hasUI) return;
		const counts = countStatuses(this.manager.list());
		if (counts.running + counts.idle === 0) {
			if (this.mounted) ctx.ui.setWidget(WIDGET, undefined);
			this.mounted = false;
			this.widgetTui = undefined;
			return;
		}
		if (this.mounted) {
			this.widgetTui?.requestRender();
			return;
		}
		this.mounted = true;
		ctx.ui.setWidget(
			WIDGET,
			(tui, theme) => {
				this.widgetTui = tui;
				return {
					render: (width: number) => {
						const current = countStatuses(this.manager.list());
						const line = `${theme.fg("accent", "subagents")}  ${countsText(current, theme)}  ${theme.fg("dim", `· ${SHORTCUT}`)}`;
						return [fitLine(line, width, theme)];
					},
					invalidate() {},
					dispose: () => {
						this.widgetTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	async open(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom<undefined>(
			(tui, theme, _keys, done) => {
				let selectedId: string | undefined;
				const ticker = setInterval(() => {
					if (this.manager.list().some((record) => record.running)) tui.requestRender();
				}, REFRESH_MS);
				ticker.unref?.();

				const ordered = (): AgentRecord[] => {
					const records = this.manager.list();
					return SECTIONS.flatMap((status) => records.filter((record) => agentStatus(record) === status));
				};
				const selected = (): AgentRecord | undefined => {
					const records = ordered();
					const record = records.find((item) => item.id === selectedId) ?? records[0];
					selectedId = record?.id;
					return record;
				};
				const move = (delta: number): void => {
					const records = ordered();
					const index = records.findIndex((item) => item.id === selected()?.id);
					selectedId = records[Math.max(0, Math.min(records.length - 1, index + delta))]?.id;
					tui.requestRender();
				};

				return {
					dispose: () => clearInterval(ticker),
					invalidate() {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return done(undefined);
						if (matchesKey(data, "up") || data === "k") return move(-1);
						if (matchesKey(data, "down") || data === "j") return move(1);
						if (data === "s") {
							const record = selected();
							if (record) this.manager.stop(record, "user");
							tui.requestRender();
						}
					},
					render: (width: number) => {
						const inner = Math.max(1, width - 3);
						const now = Date.now();
						const records = ordered();
						const current = selected();
						const counts = countsText(countStatuses(records), theme);
						const lines = counts ? [counts, ""] : [];
						if (!records.length) {
							lines.push(theme.fg("dim", "No subagents yet."));
						} else {
							const widths = layout(records, inner, now);
							lines.push(theme.bold(tableRow(["Session", "Model", "Activity", "Cost", "Age"], widths)));
							for (const status of SECTIONS) {
								const group = records.filter((record) => agentStatus(record) === status);
								if (!group.length) continue;
								lines.push("", theme.fg("muted", `${SECTION_TITLES[status]} (${group.length})`));
								for (const record of group) {
									const row = tableRow(
										[
											`${rowIcon(status, theme)} ${record.name}`,
											theme.fg("muted", modelLabel(record)),
											theme.fg("dim", activityLabel(record, now)),
											theme.fg("dim", `$${record.cost.toFixed(2)}`),
											theme.fg("dim", age(record.createdAt, now)),
										],
										widths,
									);
									lines.push(record.id === current?.id ? highlight(row, inner, theme) : row);
								}
							}
						}
						if (current) {
							lines.push("", theme.fg("muted", `${current.name} · ${current.id}`));
							const detail = current.lastError ? `error: ${current.lastError}` : (current.lastText ?? "");
							const wrapped = detail ? wrapTextWithAnsi(detail.trim(), inner) : [];
							for (const line of wrapped.slice(0, DETAIL_LINES)) lines.push(theme.fg("dim", line));
							if (current.sessionFile) lines.push(fitLine(theme.fg("dim", current.sessionFile), inner, theme));
						}
						lines.push("", theme.fg("dim", "↑/↓ navigate   s stop   q close"));
						return frame(lines, width, theme, "Subagents");
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
		);
	}
}
