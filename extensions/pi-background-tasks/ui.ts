import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderer,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	cell,
	cellEnd,
	duration,
	elapsed,
	eventText,
	fitLine,
	frame,
	lastOutputLine,
	oneLine,
	type TaskKind,
	taskIcon,
	taskKind,
	taskLine,
	taskStatus,
	visibleTasks,
} from "./render.ts";
import type { BackgroundRuntime, TaskEvent, TaskSnapshot } from "./runtime.ts";
import { tail } from "./runtime.ts";

export const COMMAND = "bg";
export const SHORTCUT = "ctrl+shift+b";
export const MESSAGE = "pi-background-tasks:event";
const WIDGET = "pi-background-tasks";
const TASK_ROWS = 10;
const OUTPUT_ROWS = 10;
const REFRESH_MS = 1000;

export interface TaskMessageDetails {
	events: TaskEvent[];
}

const EVENT_LABELS: Record<TaskKind, string> = {
	running: "Background task running",
	done: "Background task finished",
	failed: "Background task failed",
	stopped: "Background task stopped",
};

const EVENT_COLORS: Record<TaskKind, "accent" | "success" | "error" | "warning"> = {
	running: "accent",
	done: "success",
	failed: "error",
	stopped: "warning",
};

class TaskEventLines implements Component {
	constructor(
		private readonly events: TaskEvent[],
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		const separator = theme.fg("dim", " · ");
		const lines: string[] = [];
		for (const { task, output } of this.events) {
			const kind = taskKind(task);
			const head = `${theme.fg(EVENT_COLORS[kind], "◆")} ${theme.fg("muted", EVENT_LABELS[kind])}`;
			const meta = [task.id, oneLine(task.command), duration(elapsed(task))].map((part) => theme.fg("dim", part));
			lines.push(fitLine(` ${[head, ...meta].join(separator)}`, width, theme));
			if (!this.expanded) continue;
			const body = output.trim() || "(no output)";
			const textWidth = Math.max(1, width - 4);
			body
				.split("\n")
				.flatMap((line) => {
					const wrapped = wrapTextWithAnsi(line, textWidth);
					return wrapped.length > 0 ? wrapped : [""];
				})
				.forEach((line, index) => {
					const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
					lines.push(truncateToWidth(` ${prefix}${theme.fg("toolOutput", line)}`, width, ""));
				});
		}
		return lines;
	}

	invalidate(): void {}
}

export const renderTaskEvent: MessageRenderer<TaskMessageDetails> = (message, options, theme) => {
	const events = message.details?.events;
	if (!Array.isArray(events) || events.length === 0) return undefined;
	return new TaskEventLines(events, options.expanded, theme);
};

function countKinds(tasks: readonly TaskSnapshot[]): Record<TaskKind, number> {
	const counts: Record<TaskKind, number> = { running: 0, done: 0, failed: 0, stopped: 0 };
	for (const task of tasks) counts[taskKind(task)] += 1;
	return counts;
}

function countsText(tasks: readonly TaskSnapshot[], theme: Theme): string {
	const counts = countKinds(tasks);
	const parts: string[] = [];
	if (counts.running > 0) parts.push(theme.fg("success", `● ${counts.running} running`));
	if (counts.done > 0) parts.push(theme.fg("success", `✓ ${counts.done} done`));
	if (counts.failed > 0) parts.push(theme.fg("error", `✗ ${counts.failed} failed`));
	if (counts.stopped > 0) parts.push(theme.fg("dim", `• ${counts.stopped} stopped`));
	return parts.join("  ");
}

function highlight(line: string, width: number, theme: Theme): string {
	return cell(line, width)
		.split("\x1b[0m")
		.map((segment) => theme.bg("selectedBg", segment))
		.join("\x1b[0m");
}

interface Layout {
	task: number;
	command: number;
	status: number;
	output: number;
	time: number;
}

function layout(tasks: readonly TaskSnapshot[], width: number, now: number): Layout {
	const task = tasks.reduce((size, item) => Math.max(size, visibleWidth(item.id) + 2), 6);
	const time = tasks.reduce((size, item) => Math.max(size, duration(elapsed(item, now)).length), 4);
	const status = Math.min(
		20,
		tasks.reduce((size, item) => Math.max(size, taskStatus(item).length), 6),
	);
	const rest = Math.max(0, width - task - time - status - 8);
	const command = Math.max(0, Math.ceil(rest / 2));
	return { task, command, status, output: Math.max(0, rest - command), time };
}

function tableRow(columns: string[], widths: Layout): string {
	const [task = "", command = "", status = "", output = "", time = ""] = columns;
	return [
		cell(task, widths.task),
		cell(command, widths.command),
		cell(status, widths.status),
		cell(output, widths.output),
		cellEnd(time, widths.time),
	].join("  ");
}

export class BackgroundUI {
	private active: ExtensionContext | null = null;
	private requestRender: (() => void) | null = null;
	private widgetMounted = false;
	private readonly pendingEvents = new Map<string, TaskEvent>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly runtime: BackgroundRuntime,
	) {}

	attach(ctx: ExtensionContext): void {
		this.active = ctx;
		this.refresh();
	}

	handleEvent(event: TaskEvent): void {
		if (event.type === "running") {
			this.active?.ui.notify(eventText(event), "info");
			try {
				this.pi.sendMessage<TaskMessageDetails>(
					{ customType: MESSAGE, content: eventText(event), details: { events: [event] }, display: false },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {}
			return;
		}
		this.pendingEvents.set(event.task.id, event);
		void this.flushEvents();
	}

	async flushEvents(): Promise<void> {
		const events = [...this.pendingEvents.values()].filter((event) => this.runtime.get(event.task.id));
		this.pendingEvents.clear();
		if (!events.length) return;
		const content = events.map(eventText).join("\n");
		// Follow-up enters after the run finishes its pending work. A steer would be
		// picked up by the catch-up poll right after compaction and continue the
		// session mid-run; when idle it triggers a run.
		try {
			await this.pi.sendMessage<TaskMessageDetails>(
				{ customType: MESSAGE, content, details: { events }, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			for (const event of events) if (this.runtime.get(event.task.id)) this.pendingEvents.set(event.task.id, event);
		}
	}

	refresh(): void {
		const ctx = this.active;
		if (!ctx) return;
		if (!visibleTasks(this.runtime).some((task) => task.status === "running")) {
			if (this.widgetMounted) ctx.ui.setWidget(WIDGET, undefined);
			this.widgetMounted = false;
			this.requestRender = null;
			return;
		}
		if (this.widgetMounted) {
			this.requestRender?.();
			return;
		}
		this.widgetMounted = true;
		ctx.ui.setWidget(
			WIDGET,
			(tui, theme) => {
				this.requestRender = () => tui.requestRender();
				return {
					dispose: () => {
						this.requestRender = null;
						this.widgetMounted = false;
					},
					invalidate() {},
					render: (width: number) => {
						const line = `${theme.fg("accent", "bg tasks")}  ${countsText(visibleTasks(this.runtime), theme)}  ${theme.fg("dim", `· ${SHORTCUT}`)}`;
						return [fitLine(line, width, theme)];
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	clearWidget(): void {
		this.active?.ui.setWidget(WIDGET, undefined);
		this.active = null;
		this.requestRender = null;
		this.widgetMounted = false;
		this.pendingEvents.clear();
	}

	listText(): string {
		const tasks = visibleTasks(this.runtime);
		return tasks.length ? tasks.map(taskLine).join("\n\n") : "No background tasks.";
	}

	async open(ctx: ExtensionCommandContext | ExtensionContext, initialId?: string): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(this.listText(), "info");
			return;
		}
		await ctx.ui.custom<undefined>(
			(tui, theme, _keys, done) => {
				let selectedId = initialId;
				let outputScroll = 0;
				let follow = true;
				const ticker = setInterval(() => {
					if (visibleTasks(this.runtime).some((task) => task.status === "running")) tui.requestRender();
				}, REFRESH_MS);
				ticker.unref?.();

				const ordered = (): TaskSnapshot[] => {
					const tasks = visibleTasks(this.runtime);
					return [
						...tasks.filter((task) => task.status === "running"),
						...tasks.filter((task) => task.status !== "running"),
					];
				};
				const selected = (): TaskSnapshot | undefined => {
					const tasks = ordered();
					const task = tasks.find((item) => item.id === selectedId) ?? tasks[0];
					selectedId = task?.id;
					return task;
				};
				const outputLines = (task: TaskSnapshot): string[] => {
					const lines = tail(this.runtime.output(task.id) ?? "", 120_000)
						.trim()
						.split(/\r?\n/);
					return lines.some(Boolean) ? lines : ["(no output yet)"];
				};
				const maxScroll = (task: TaskSnapshot | undefined): number =>
					task ? Math.max(0, outputLines(task).length - OUTPUT_ROWS) : 0;
				const move = (delta: number): void => {
					const tasks = ordered();
					const index = tasks.findIndex((item) => item.id === selected()?.id);
					selectedId = tasks[Math.max(0, Math.min(tasks.length - 1, index + delta))]?.id;
					follow = true;
					tui.requestRender();
				};
				const scroll = (delta: number): void => {
					const max = maxScroll(selected());
					outputScroll = Math.max(0, Math.min(max, outputScroll + delta));
					follow = outputScroll === max;
					tui.requestRender();
				};

				return {
					dispose: () => clearInterval(ticker),
					invalidate() {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return done(undefined);
						if (matchesKey(data, "shift+up")) return scroll(-OUTPUT_ROWS);
						if (matchesKey(data, "shift+down")) return scroll(OUTPUT_ROWS);
						if (matchesKey(data, "up") || data === "k") return move(-1);
						if (matchesKey(data, "down") || data === "j") return move(1);
						if (data === "f") {
							follow = !follow;
							return tui.requestRender();
						}
						if (data === "s") {
							this.runtime.stop(selected()?.id, "user");
							return tui.requestRender();
						}
						if (data === "c") {
							this.runtime.clear();
							return tui.requestRender();
						}
					},
					render: (width: number) => {
						const inner = Math.max(1, width - 3);
						const now = Date.now();
						const tasks = ordered();
						const current = selected();
						const counts = countsText(tasks, theme);
						const lines = counts ? [counts, ""] : [];
						if (!tasks.length) {
							lines.push(theme.fg("dim", "No background tasks yet. Use /bg run <command> or background_task."));
						} else {
							const widths = layout(tasks, inner, now);
							lines.push(theme.bold(tableRow(["Task", "Command", "Status", "Last output", "Time"], widths)));
							const index = Math.max(
								0,
								tasks.findIndex((task) => task.id === current?.id),
							);
							const start = Math.max(0, Math.min(tasks.length - TASK_ROWS, index - Math.floor(TASK_ROWS / 2)));
							let section: string | undefined;
							for (const task of tasks.slice(start, start + TASK_ROWS)) {
								const title = task.status === "running" ? "Running" : "Finished";
								if (title !== section) {
									section = title;
									const count = tasks.filter((item) => (item.status === "running") === (title === "Running")).length;
									lines.push("", theme.fg("muted", `${title} (${count})`));
								}
								const row = tableRow(
									[
										`${taskIcon(task, theme)} ${task.id}`,
										oneLine(task.command),
										theme.fg("dim", taskStatus(task)),
										theme.fg("dim", lastOutputLine(this.runtime.output(task.id))),
										theme.fg("dim", duration(elapsed(task, now))),
									],
									widths,
								);
								lines.push(task.id === current?.id ? highlight(row, inner, theme) : row);
							}
						}
						if (current) {
							const output = outputLines(current);
							if (follow) outputScroll = maxScroll(current);
							outputScroll = Math.min(outputScroll, maxScroll(current));
							lines.push(
								"",
								theme.fg(
									"muted",
									`${current.id} · pid ${current.pid} · ${current.cwd}${follow ? theme.fg("dim", " · follow") : ""}`,
								),
							);
							for (const line of output.slice(outputScroll, outputScroll + OUTPUT_ROWS)) {
								lines.push(theme.fg("toolOutput", line));
							}
							lines.push(fitLine(theme.fg("dim", current.logFile), inner, theme));
						}
						lines.push("", theme.fg("dim", "↑/↓ navigate   shift+↑/↓ scroll   f follow   s stop   c clear   q close"));
						return frame(lines, width, theme, "Background tasks");
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
		);
	}
}
