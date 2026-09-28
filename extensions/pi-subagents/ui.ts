import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration } from "../shared/format.ts";
import { type Column, fitLine, frame, highlight, listSelection, StatusLineWidget, tableRow } from "../shared/ui.ts";
import { preview } from "./delegation.ts";
import type { SubagentManager } from "./manager.ts";
import { type AgentRecord, type AgentStatus, agentStatus } from "./types.ts";

export const COMMAND = "agents";
export const SHORTCUT = "ctrl+shift+s";
const WIDGET = "pi-subagents";
const REFRESH_MS = 1000;
const STATUS_ROW_ICON = "•";
const SECTIONS: readonly AgentStatus[] = ["running", "inactive"];
const SECTION_TITLES: Record<AgentStatus, string> = { running: "Running", inactive: "Inactive" };
const DETAIL_LINES = 6;

interface Counts {
	running: number;
	inactive: number;
}

function countStatuses(records: readonly AgentRecord[]): Counts {
	const counts: Counts = { running: 0, inactive: 0 };
	for (const record of records) counts[agentStatus(record)] += 1;
	return counts;
}

function countsText(counts: Counts, theme: Theme): string {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(theme.fg("success", `● ${counts.running} running`));
	if (counts.inactive > 0) parts.push(theme.fg("dim", `○ ${counts.inactive} inactive`));
	return parts.join("  ");
}

function modelLabel(record: AgentRecord): string {
	if (!record.model) return "-";
	const bare = record.model.slice(record.model.lastIndexOf("/") + 1) || record.model;
	return record.thinking && record.thinking !== "off" ? `${bare}:${record.thinking}` : bare;
}

function activityLabel(record: AgentRecord, now: number): string {
	if (record.running) return `${record.activity ?? "Waiting"} · ${formatDuration(now - (record.runStartedAt ?? now))}`;
	if (record.lastError) return `error: ${record.lastError}`;
	return preview(record.lastText) ?? "";
}

function rowIcon(status: AgentStatus, theme: Theme): string {
	if (status === "running") {
		return theme.bold("◈");
	}
	return theme.bold(theme.fg("dim", STATUS_ROW_ICON));
}

function layout(records: readonly AgentRecord[], width: number, now: number): Column[] {
	const cost = records.reduce((size, record) => Math.max(size, `$${record.cost.toFixed(2)}`.length), 4);
	const ageWidth = records.reduce((size, record) => Math.max(size, formatDuration(now - record.createdAt).length), 3);
	const available = Math.max(0, width - cost - ageWidth - 4);
	const desiredModel = records.reduce((size, record) => Math.max(size, visibleWidth(modelLabel(record))), 5);
	const model = Math.min(desiredModel, 32, Math.max(0, available - 12));
	const name = Math.min(28, Math.max(0, available - model - 2));
	const activity = Math.max(0, available - model - name - 4);
	return [
		{ width: name },
		{ width: model },
		{ width: activity },
		{ width: cost, alignEnd: true },
		{ width: ageWidth, alignEnd: true },
	];
}

export class AgentsUI {
	private context?: ExtensionContext;
	private readonly widget = new StatusLineWidget(
		WIDGET,
		(theme) =>
			`${theme.fg("accent", "subagents")}  ${countsText(countStatuses(this.manager.list()), theme)}  ${theme.fg("dim", `· ${SHORTCUT}`)}`,
	);

	constructor(private readonly manager: SubagentManager) {}

	attach(ctx: ExtensionContext): void {
		this.context = ctx;
		this.update();
	}

	detach(): void {
		if (this.context) this.widget.clear(this.context);
		this.context = undefined;
	}

	update(): void {
		const ctx = this.context;
		if (!ctx?.hasUI) return;
		this.widget.update(ctx, countStatuses(this.manager.list()).running > 0);
	}

	async open(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom<undefined>(
			(tui, theme, _keys, done) => {
				const ticker = setInterval(() => {
					if (this.manager.list().some((record) => record.running)) tui.requestRender();
				}, REFRESH_MS);
				ticker.unref?.();

				const ordered = (): AgentRecord[] => {
					const records = this.manager.list();
					return SECTIONS.flatMap((status) => records.filter((record) => agentStatus(record) === status));
				};
				const { selected, move: moveSelection } = listSelection(ordered);
				const move = (delta: number): void => {
					moveSelection(delta);
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
											theme.fg("dim", formatDuration(now - record.createdAt)),
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
