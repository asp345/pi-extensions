import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "./manager.ts";
import { compactTranscript } from "./transcript.ts";
import type { AgentRecord } from "./types.ts";

export const COMMAND = "agents";
export const SHORTCUT = "ctrl+shift+s";
const WIDGET = "pi-subagents";
const AGENT_ROWS = 10;
const DETAIL_ROWS = 12;

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function shortId(id: string): string {
	return id.length <= 8 ? id : id.slice(0, 8);
}

function pad(text: string, width: number): string {
	const value = truncateToWidth(text, width);
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function frame(lines: string[], width: number, theme: Theme, title: string): string[] {
	if (width < 5) return lines.map((line) => truncateToWidth(line, width));
	const innerWidth = width - 2;
	const contentWidth = Math.max(1, innerWidth - 2);
	const label = truncateToWidth(` ${title} `, innerWidth);
	const topFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(label)));
	return [
		`${theme.fg("border", "╭")}${theme.fg("accent", theme.bold(label))}${theme.fg("border", `${topFill}╮`)}`,
		...lines.map((line) => `${theme.fg("border", "│")} ${pad(line, contentWidth)} ${theme.fg("border", "│")}`),
		`${theme.fg("border", `╰${"─".repeat(innerWidth)}╯`)}`,
	];
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function agentLine(record: AgentRecord): string {
	const elapsed = (record.completedAt ?? Date.now()) - record.startedAt;
	return `${record.id} · ${record.status} · ${record.turns} turns · ${record.toolUses} tools · ${duration(elapsed)} · ${oneLine(record.title)}`;
}

interface WidgetTui {
	requestRender(force?: boolean): void;
}

export class AgentsUI {
	private context?: ExtensionContext;
	private widgetTui?: WidgetTui;
	private mounted = false;
	private resumeHandler?: (id: string) => Promise<string>;

	constructor(private readonly manager: AgentManager) {}

	setResumeHandler(handler: (id: string) => Promise<string>): void {
		this.resumeHandler = handler;
	}

	attach(ctx: ExtensionContext): void {
		this.context = ctx;
		this.updateWidget();
	}

	detach(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET, undefined);
		this.context = undefined;
		this.widgetTui = undefined;
		this.mounted = false;
	}

	updateWidget(force = false): void {
		const ctx = this.context;
		if (!ctx) return;
		if (!this.manager.running().length) {
			if (this.mounted) ctx.ui.setWidget(WIDGET, undefined);
			this.mounted = false;
			this.widgetTui = undefined;
			return;
		}
		if (this.mounted) {
			this.widgetTui?.requestRender(force);
			return;
		}
		this.mounted = true;
		ctx.ui.setWidget(
			WIDGET,
			(tui, theme) => {
				this.widgetTui = tui;
				return {
					render: (width: number) => {
						const running = this.manager.running();
						const line = `${theme.fg("accent", theme.bold("Subagents"))} ${theme.fg("muted", `${running.length} running`)} ${theme.fg("dim", `· ${SHORTCUT} dashboard`)}`;
						return [truncateToWidth(line, width, theme.fg("dim", "..."))];
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

	listText(): string {
		const records = this.manager.list();
		if (!records.length) return "No subagents.";
		return records.map(agentLine).join("\n");
	}

	async open(ctx: ExtensionCommandContext | ExtensionContext, initialId?: string): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(this.listText(), "info");
			return;
		}
		await ctx.ui.custom(
			(tui, theme, _keys, done) => {
				let selectedId = initialId?.trim() ?? this.manager.running()[0]?.id ?? this.manager.list()[0]?.id;
				let agentScroll = 0;
				let detailScroll = 0;
				let showFinished = false;

				const visible = (): AgentRecord[] => {
					const records = this.manager.list();
					return showFinished ? records : records.filter((item) => item.status === "running");
				};
				const fingerprint = (): string =>
					this.manager
						.list()
						.map((item) => `${item.id}:${item.status}:${item.turns}:${item.toolUses}:${item.result?.length ?? 0}`)
						.join("|");
				let lastFingerprint = fingerprint();
				const timer: ReturnType<typeof setInterval> = setInterval(() => {
					const current = fingerprint();
					if (current === lastFingerprint) return;
					lastFingerprint = current;
					tui.requestRender();
				}, 1000);
				timer.unref?.();

				const selected = (): AgentRecord | undefined => {
					const records = visible();
					const record = records.find((item) => item.id === selectedId) ?? records[0];
					selectedId = record?.id;
					return record;
				};
				const detailLines = (record: AgentRecord | undefined): string[] => {
					if (!record) return ["(no subagents)"];
					const transcript = record.messages.length ? compactTranscript(record.messages) : "";
					const answer = (record.result || record.error || "").trim();
					const lines = [
						`ID: ${record.id}`,
						`Title: ${record.title}`,
						`Status: ${record.status}`,
						`Turns: ${record.turns} · Tools: ${record.toolUses}`,
						`Model: ${record.model ?? "parent"}`,
						`Duration: ${duration((record.completedAt ?? Date.now()) - record.startedAt)}`,
					];
					if (answer) lines.push("", "Answer:", ...answer.split(/\r?\n/).slice(0, 6));
					if (transcript) lines.push("", "Transcript:", ...transcript.split(/\r?\n/).slice(0, 6));
					return lines.length ? lines : ["(no details)"];
				};
				const move = (delta: number): void => {
					const records = visible();
					if (!records.length) return;
					const current = Math.max(
						0,
						records.findIndex((item) => item.id === selectedId),
					);
					const next = Math.max(0, Math.min(records.length - 1, current + delta));
					selectedId = records[next]?.id;
					detailScroll = 0;
					agentScroll = Math.max(
						0,
						Math.min(
							Math.max(0, records.length - AGENT_ROWS),
							next < agentScroll ? next : next >= agentScroll + AGENT_ROWS ? next - AGENT_ROWS + 1 : agentScroll,
						),
					);
					tui.requestRender();
				};

				return {
					dispose: () => {
						clearInterval(timer);
					},
					invalidate() {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return done(undefined);
						if (data === "a") {
							showFinished = !showFinished;
							detailScroll = 0;
							return tui.requestRender();
						}
						if (matchesKey(data, "up") || data === "k") return move(-1);
						if (matchesKey(data, "down") || data === "j") return move(1);
						if (matchesKey(data, "shift+up")) return move(-AGENT_ROWS);
						if (matchesKey(data, "shift+down")) return move(AGENT_ROWS);
						if (data === "s" || data === "x") {
							if (selectedId) this.manager.stop(selectedId, false);
							return tui.requestRender();
						}
						if (data === "r") {
							const id = selectedId;
							if (id && this.resumeHandler) {
								void this.resumeHandler(id)
									.then((message) => ctx.ui.notify(message, "info"))
									.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"))
									.finally(() => tui.requestRender());
							}
							return tui.requestRender();
						}
						if (data === "J") {
							detailScroll = Math.max(0, detailScroll + 1);
							return tui.requestRender();
						}
						if (data === "K") {
							detailScroll = Math.max(0, detailScroll - 1);
							return tui.requestRender();
						}
					},
					render: (width: number) => {
						const records = visible();
						const total = this.manager.list().length;
						const record = selected();
						const running = this.manager.running().length;
						const finished = total - running;
						const result = [
							theme.fg(
								"muted",
								showFinished
									? `${running} running · ${finished} finished`
									: finished > 0
										? `${running} running · ${finished} finished (hidden)`
										: `${running} running`,
							),
							theme.fg("dim", "[↑↓] move · [s] stop · [r] resume · [a] finished · [q] close"),
							"",
						];
						if (!records.length) {
							result.push(
								theme.fg(
									"dim",
									finished > 0 && !showFinished
										? "No running subagents. Press a to show finished."
										: "No subagents yet. Use launch_subagent.",
								),
							);
							return frame(result, width, theme, "Subagents");
						}
						const contentWidth = Math.max(1, width - 4);
						const leftWidth = Math.max(30, Math.min(42, Math.floor(contentWidth * 0.34)));
						const rightWidth = Math.max(24, contentWidth - leftWidth - 3);
						const left = [theme.fg("accent", theme.bold(`Agents (${records.length})`)), ""];
						for (const item of records.slice(agentScroll, agentScroll + AGENT_ROWS)) {
							left.push(
								`${item.id === record?.id ? theme.fg("accent", "→") : "·"} ${shortId(item.id)} ${theme.fg("dim", item.status)}`,
							);
							left.push(`  ${oneLine(item.title)}`);
						}
						const details = detailLines(record).slice(detailScroll, detailScroll + DETAIL_ROWS);
						const right = [
							theme.fg("accent", theme.bold(`Detail ${record ? shortId(record.id) : ""}`)),
							"",
							...details,
						];
						for (let row = 0; row < Math.max(left.length, right.length); row++) {
							result.push(
								`${pad(left[row] ?? "", leftWidth)}${theme.fg("dim", " │ ")}${truncateToWidth(right[row] ?? "", rightWidth)}`,
							);
						}
						return frame(result, width, theme, "Subagents");
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 96, maxHeight: "80%", margin: { bottom: 4 } },
			},
		);
	}
}
