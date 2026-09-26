import type { ExtensionAPI, ExtensionContext, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	type Column,
	fitLine,
	frame,
	highlight,
	listSelection,
	MessageLines,
	StatusLineWidget,
	tableRow,
} from "../shared/ui.ts";
import {
	duration,
	elapsed,
	eventText,
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

export const COMMAND = "bg";
export const SHORTCUT = "ctrl+shift+b";
export const MESSAGE = "pi-background-tasks:event";
const WIDGET = "pi-background-tasks";
const TASK_ROWS = 10;
const OUTPUT_ROWS = 10;
const REFRESH_MS = 1000;

interface TaskMessageDetails {
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

export const renderTaskEvent: MessageRenderer<TaskMessageDetails> = (message, options, theme) => {
	const events = message.details?.events;
	if (!Array.isArray(events) || events.length === 0) return undefined;
	const entries = events.map(({ task, output }) => {
		const kind = taskKind(task);
		return {
			marker: theme.fg(EVENT_COLORS[kind], "◆"),
			label: EVENT_LABELS[kind],
			meta: [task.id, oneLine(task.command), duration(elapsed(task))],
			body: options.expanded ? output.trim() || "(no output)" : undefined,
		};
	});
	return new MessageLines(entries, "toolOutput", theme);
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

function layout(tasks: readonly TaskSnapshot[], width: number, now: number): Column[] {
	const task = tasks.reduce((size, item) => Math.max(size, visibleWidth(item.id) + 2), 6);
	const time = tasks.reduce((size, item) => Math.max(size, duration(elapsed(item, now)).length), 4);
	const status = Math.min(
		20,
		tasks.reduce((size, item) => Math.max(size, taskStatus(item).length), 6),
	);
	const rest = Math.max(0, width - task - time - status - 8);
	const command = Math.max(0, Math.ceil(rest / 2));
	return [
		{ width: task },
		{ width: command },
		{ width: status },
		{ width: Math.max(0, rest - command) },
		{ width: time, alignEnd: true },
	];
}

export class BackgroundUI {
	private active: ExtensionContext | null = null;
	private readonly widget = new StatusLineWidget(
		WIDGET,
		(theme) =>
			`${theme.fg("accent", "bg tasks")}  ${countsText(visibleTasks(this.runtime), theme)}  ${theme.fg("dim", `· ${SHORTCUT}`)}`,
	);
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
		if (!this.active) return;
		this.widget.update(
			this.active,
			visibleTasks(this.runtime).some((task) => task.status === "running"),
		);
	}

	clearWidget(): void {
		if (this.active) this.widget.clear(this.active);
		this.active = null;
		this.pendingEvents.clear();
	}

	listText(): string {
		const tasks = visibleTasks(this.runtime);
		return tasks.length ? tasks.map(taskLine).join("\n\n") : "No background tasks.";
	}

	async open(ctx: ExtensionContext, initialId?: string): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(this.listText(), "info");
			return;
		}
		await ctx.ui.custom<undefined>(
			(tui, theme, _keys, done) => {
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
				const selection = listSelection(ordered, initialId);
				const selected = selection.selected;
				const outputLines = (task: TaskSnapshot): string[] => {
					const lines = (this.runtime.output(task.id) ?? "").trim().split(/\r?\n/);
					return lines.some(Boolean) ? lines : ["(no output yet)"];
				};
				const maxScroll = (task: TaskSnapshot | undefined): number =>
					task ? Math.max(0, outputLines(task).length - OUTPUT_ROWS) : 0;
				const move = (delta: number): void => {
					selection.move(delta);
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
