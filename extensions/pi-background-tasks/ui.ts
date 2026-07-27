import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundRuntime, TaskEvent, TaskSnapshot } from "./runtime.js";
import { tail } from "./runtime.js";

export const COMMAND = "bg";
export const SHORTCUT = "ctrl+shift+b";
const MESSAGE = "pi-background-tasks:event";
const WIDGET = "pi-background-tasks";
const TASK_ROWS = 12;
const OUTPUT_ROWS = 14;

type Pane = "tasks" | "output";

export function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function relative(timestamp: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 1) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	return `${Math.floor(seconds / 3600)}h ago`;
}

export function taskStatus(task: TaskSnapshot): string {
	if (task.status === "running") return "running";
	if (task.status === "stopped") return "stopped";
	return `${task.status} (exit ${task.exitCode ?? "?"})`;
}

export function taskLine(task: TaskSnapshot): string {
	return `${task.id} · ${taskStatus(task)} · pid ${task.pid} · ${task.title} · ${relative(task.lastOutputAt ?? task.updatedAt)}`;
}

function pad(text: string, width: number): string {
	const value = truncateToWidth(text, width);
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function eventLines(event: TaskEvent, theme: Theme, expanded: boolean): string[] {
	const title = event.type === "exit" ? "Background task finished" : "Background task output";
	const lines = [
		theme.fg(event.type === "exit" ? "success" : "accent", theme.bold(title)),
		`${theme.fg("muted", "Task")}: ${event.task.id} · ${event.task.title}`,
		`${theme.fg("muted", "Status")}: ${taskStatus(event.task)} · pid ${event.task.pid}`,
		`${theme.fg("muted", "Started")}: ${relative(event.task.startedAt)} · ${duration(Date.now() - event.task.startedAt)} elapsed`,
		`${theme.fg("muted", "Command")}: ${event.task.command}`,
		`${theme.fg("muted", "Log")}: ${event.task.logFile}`,
		"",
		theme.fg("accent", theme.bold("Recent output")),
	];
	const output = event.output.trim() ? event.output.split(/\r?\n/) : ["(no output yet)"];
	lines.push(...(expanded ? output : output.slice(-8)));
	if (!expanded && output.length > 8) lines.push(theme.fg("dim", "Expand to inspect more output."));
	return lines;
}

export class BackgroundUI {
	private active: ExtensionContext | null = null;
	private requestRender: (() => void) | null = null;
	private widgetMounted = false;
	private readonly pendingExits = new Map<string, TaskEvent>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly runtime: BackgroundRuntime,
	) {
		pi.registerMessageRenderer(MESSAGE, (message, { expanded }, theme) => {
			const details = message.details as TaskEvent | undefined;
			const body = details?.task
				? eventLines(details, theme, expanded).join("\n")
				: String(message.content ?? "Background task update");
			return new Text(body, 1, 0, (value) => theme.bg("customMessageBg", value));
		});
	}

	attach(ctx: ExtensionContext): void {
		this.active = ctx;
		this.refresh();
	}

	handleEvent(event: TaskEvent): void {
		if (event.type === "output") {
			this.pi.sendMessage(
				{
					customType: MESSAGE,
					content: `Background task ${event.task.id} emitted output.`,
					details: event,
					display: true,
				},
				{ triggerTurn: false },
			);
			return;
		}
		this.pendingExits.set(event.task.id, event);
		this.active?.ui.notify(`Background task ${event.task.id} finished (${taskStatus(event.task)}).`, "info");
		if (this.active?.isIdle() && !this.active.hasPendingMessages()) void this.flushExits();
	}

	async flushExits(): Promise<void> {
		const events = [...this.pendingExits.values()].filter((event) => this.runtime.get(event.task.id));
		this.pendingExits.clear();
		if (!events.length) return;
		const content = events
			.map((event) => `Background task ${event.task.id} finished (${taskStatus(event.task)}).`)
			.join("\n");
		try {
			await this.pi.sendMessage(
				{ customType: MESSAGE, content, details: events.length === 1 ? events[0] : undefined, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			for (const event of events) if (this.runtime.get(event.task.id)) this.pendingExits.set(event.task.id, event);
		}
	}

	refresh(): void {
		const ctx = this.active;
		if (!ctx) return;
		const tasks = this.runtime.list();
		if (!tasks.length) {
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
				let timer: ReturnType<typeof setInterval> | null = null;
				return {
					dispose: () => {
						if (timer) clearInterval(timer);
						timer = null;
						this.requestRender = null;
						this.widgetMounted = false;
					},
					invalidate() {},
					render: (width: number) => {
						const current = this.runtime.list();
						const hasRunning = current.some((task) => task.status === "running");
						if (hasRunning && !timer) {
							timer = setInterval(() => tui.requestRender(), 1000);
							timer.unref?.();
						} else if (!hasRunning && timer) {
							clearInterval(timer);
							timer = null;
						}
						const running = current.filter((task) => task.status === "running").length;
						const latest = current[0];
						return [
							`${theme.fg("accent", theme.bold("Background tasks"))} ${theme.fg("muted", `${running} running · ${current.length - running} finished`)}`,
							latest
								? `${theme.fg("dim", `${latest.id} · ${latest.title} · ${relative(latest.lastOutputAt ?? latest.updatedAt)}`)} · ${theme.fg("muted", `${SHORTCUT} dashboard`)}`
								: "",
						]
							.filter(Boolean)
							.map((line) => truncateToWidth(line, width));
					},
				};
			},
			{ placement: "belowEditor" },
		);
		this.requestRender?.();
	}

	clearWidget(): void {
		this.active?.ui.setWidget(WIDGET, undefined);
		this.active = null;
		this.requestRender = null;
		this.widgetMounted = false;
		this.pendingExits.clear();
	}

	listText(): string {
		const tasks = this.runtime.list();
		return tasks.length ? tasks.map(taskLine).join("\n\n") : "No background tasks.";
	}

	async open(ctx: ExtensionCommandContext | ExtensionContext, initialId?: string, pane: Pane = "tasks"): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(this.listText(), "info");
			return;
		}
		await ctx.ui.custom(
			(tui, theme, _keys, done) => {
				let selectedId = initialId ?? this.runtime.list()[0]?.id;
				let focus = pane;
				let taskScroll = 0;
				let outputScroll = 0;
				let follow = true;
				let timer: ReturnType<typeof setInterval> | null = setInterval(() => tui.requestRender(), 1000);
				timer.unref?.();

				const selected = (): TaskSnapshot | undefined => {
					const tasks = this.runtime.list();
					const task = tasks.find((item) => item.id === selectedId) ?? tasks[0];
					selectedId = task?.id;
					return task;
				};
				const linesFor = (task: TaskSnapshot | undefined): string[] => {
					const value = task ? (this.runtime.output(task.id) ?? "") : "";
					const lines = tail(value, 120_000).trim().split(/\r?\n/);
					return lines.some(Boolean) ? lines : ["(no output yet)"];
				};
				const syncOutput = (force = false): void => {
					const max = Math.max(0, linesFor(selected()).length - OUTPUT_ROWS);
					if (force || follow) outputScroll = max;
					else outputScroll = Math.max(0, Math.min(max, outputScroll));
				};
				const moveTask = (delta: number): void => {
					const tasks = this.runtime.list();
					if (!tasks.length) return;
					const current = Math.max(
						0,
						tasks.findIndex((item) => item.id === selectedId),
					);
					const next = Math.max(0, Math.min(tasks.length - 1, current + delta));
					selectedId = tasks[next]?.id;
					taskScroll = Math.max(
						0,
						Math.min(
							Math.max(0, tasks.length - TASK_ROWS),
							next < taskScroll ? next : next >= taskScroll + TASK_ROWS ? next - TASK_ROWS + 1 : taskScroll,
						),
					);
					syncOutput(true);
					tui.requestRender();
				};
				const moveOutput = (delta: number): void => {
					const max = Math.max(0, linesFor(selected()).length - OUTPUT_ROWS);
					outputScroll = Math.max(0, Math.min(max, outputScroll + delta));
					follow = outputScroll === max;
					tui.requestRender();
				};

				return {
					dispose: () => {
						if (timer) clearInterval(timer);
						timer = null;
					},
					invalidate() {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return done(undefined);
						if (matchesKey(data, "tab")) {
							focus = focus === "tasks" ? "output" : "tasks";
							return tui.requestRender();
						}
						if (data === "f") {
							follow = !follow;
							syncOutput(follow);
							return tui.requestRender();
						}
						if (data === "s") {
							this.runtime.stop(selectedId);
							return tui.requestRender();
						}
						if (data === "c") {
							this.runtime.clear();
							return tui.requestRender();
						}
						if (matchesKey(data, "home") || data === "g")
							return focus === "tasks" ? moveTask(-Number.MAX_SAFE_INTEGER) : moveOutput(-Number.MAX_SAFE_INTEGER);
						if (matchesKey(data, "end") || data === "G")
							return focus === "tasks" ? moveTask(Number.MAX_SAFE_INTEGER) : moveOutput(Number.MAX_SAFE_INTEGER);
						if (matchesKey(data, "shift+up"))
							return focus === "tasks" ? moveTask(-TASK_ROWS) : moveOutput(-OUTPUT_ROWS);
						if (matchesKey(data, "shift+down"))
							return focus === "tasks" ? moveTask(TASK_ROWS) : moveOutput(OUTPUT_ROWS);
						if (matchesKey(data, "up") || data === "k") return focus === "tasks" ? moveTask(-1) : moveOutput(-1);
						if (matchesKey(data, "down") || data === "j") return focus === "tasks" ? moveTask(1) : moveOutput(1);
					},
					render: (width: number) => {
						const tasks = this.runtime.list();
						const task = selected();
						syncOutput();
						const running = tasks.filter((item) => item.status === "running").length;
						const result = [
							`${theme.fg("accent", theme.bold("Background tasks"))} ${theme.fg("muted", `${running} running · ${tasks.length - running} finished`)}`,
							theme.fg(
								"dim",
								"[tab] pane · [↑↓] move · [shift+↑/↓] page · [f] follow · [s] stop · [c] clear · [q] close",
							),
							"",
						];
						if (!tasks.length)
							return [...result, theme.fg("dim", "No background tasks yet. Use /bg run <command> or background_task.")];
						const leftWidth = Math.max(30, Math.min(42, Math.floor(width * 0.34)));
						const rightWidth = Math.max(24, width - leftWidth - 3);
						const left = [theme.fg(focus === "tasks" ? "accent" : "muted", theme.bold(`Tasks (${tasks.length})`)), ""];
						for (const item of tasks.slice(taskScroll, taskScroll + TASK_ROWS)) {
							left.push(
								`${item.id === task?.id ? theme.fg("accent", "→") : "·"} ${item.id} ${theme.fg("dim", taskStatus(item))}`,
							);
							left.push(`  ${item.title}`);
						}
						const right: string[] = [];
						if (task) {
							const output = linesFor(task);
							right.push(
								theme.fg(focus === "output" ? "accent" : "muted", theme.bold(`Watch ${task.id}`)) +
									theme.fg("dim", follow ? " · follow" : ""),
							);
							right.push(`${theme.fg("muted", "Status")}: ${taskStatus(task)} · pid ${task.pid}`);
							right.push(
								`${theme.fg("muted", "Started")}: ${relative(task.startedAt)} · ${duration(Date.now() - task.startedAt)} elapsed`,
							);
							right.push(`${theme.fg("muted", "Expiry")}: in ${duration(task.expiresAt - Date.now())}`);
							right.push(`${theme.fg("muted", "Command")}: ${task.command}`);
							right.push(`${theme.fg("muted", "Cwd")}: ${task.cwd}`);
							right.push(`${theme.fg("muted", "Log")}: ${task.logFile}`, "", theme.fg("accent", theme.bold("Output")));
							right.push(...output.slice(outputScroll, outputScroll + OUTPUT_ROWS));
						}
						for (let row = 0; row < Math.max(left.length, right.length); row++)
							result.push(
								`${pad(left[row] ?? "", leftWidth)}${theme.fg("dim", " │ ")}${truncateToWidth(right[row] ?? "", rightWidth)}`,
							);
						return result.map((line) => truncateToWidth(line, width));
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: 96, maxHeight: "80%" } },
		);
	}
}
