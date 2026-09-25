import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	keyHint,
	type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	duration,
	eventText,
	frame,
	lastOutputLine,
	oneLine,
	type Pane,
	pad,
	relative,
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
const TASK_ROWS = 8;
const OUTPUT_ROWS = 10;

export const renderTaskEvent: MessageRenderer<TaskEvent> = (message, options, theme) => {
	const event = message.details as TaskEvent | undefined;
	if (!event || typeof event !== "object" || !("task" in event)) return undefined;
	const task = event.task;
	const elapsed = task.status === "running" ? Date.now() - task.startedAt : task.updatedAt - task.startedAt;
	const failed = task.status !== "completed" || task.timedOut;
	const mark = theme.fg(failed ? "warning" : "success", failed ? "!" : "✓");
	const text = `${task.id} · ${oneLine(task.command)} · ${duration(elapsed)}`;
	const head = ` ${mark} ${theme.fg("toolTitle", theme.bold("done"))} ${theme.fg("dim", text)}`;
	if (!options.expanded) {
		return {
			invalidate() {},
			render(width: number): string[] {
				return [truncateToWidth(`${head} ${keyHint("app.tools.expand", "to expand")}`, width)];
			},
		};
	}
	const container = new Container();
	container.addChild(new Text(head, 0, 0));
	container.addChild(new Text(theme.fg("toolOutput", event.output.trim() || "(no output)"), 1, 0));
	return container;
};

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
				this.pi.sendMessage(
					{ customType: MESSAGE, content: eventText(event), details: event, display: false },
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
			await this.pi.sendMessage(
				{ customType: MESSAGE, content, details: events.length === 1 ? events[0] : undefined, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			for (const event of events) if (this.runtime.get(event.task.id)) this.pendingEvents.set(event.task.id, event);
		}
	}

	refresh(): void {
		const ctx = this.active;
		if (!ctx) return;
		const tasks = visibleTasks(this.runtime);
		if (!tasks.some((task) => task.status === "running")) {
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
				let lastOutputFingerprint = "";
				const outputFingerprint = (): string =>
					visibleTasks(this.runtime)
						.filter((task) => task.status === "running")
						.map(
							(task) =>
								`${task.id}:${task.lastOutputAt ?? task.updatedAt}:${this.runtime.output(task.id)?.length ?? 0}`,
						)
						.join("|");
				return {
					dispose: () => {
						if (timer) clearInterval(timer);
						timer = null;
						this.requestRender = null;
						this.widgetMounted = false;
					},
					invalidate() {},
					render: (width: number) => {
						const current = visibleTasks(this.runtime);
						const hasRunning = current.some((task) => task.status === "running");
						if (hasRunning && !timer) {
							timer = setInterval(() => {
								const fingerprint = outputFingerprint();
								if (fingerprint === lastOutputFingerprint) return;
								lastOutputFingerprint = fingerprint;
								tui.requestRender();
							}, 1000);
							timer.unref?.();
						} else if (!hasRunning && timer) {
							clearInterval(timer);
							timer = null;
						}
						const running = current.filter((task) => task.status === "running").length;
						const latest = current[0];
						const runningTask = current.find((task) => task.status === "running");
						const preview = lastOutputLine(runningTask ? this.runtime.output(runningTask.id) : undefined);
						return [
							`${theme.fg("accent", theme.bold("Background tasks"))} ${theme.fg("muted", `${running} running · ${current.length - running} finished`)}`,
							latest
								? `${theme.fg("dim", `${latest.id} · ${oneLine(latest.title)} · ${relative(latest.lastOutputAt ?? latest.updatedAt)}`)} · ${theme.fg("muted", `${SHORTCUT} dashboard`)}`
								: "",
							preview ? theme.fg("dim", `› ${preview}`) : "",
						]
							.filter(Boolean)
							.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
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
		this.pendingEvents.clear();
	}

	listText(): string {
		const tasks = visibleTasks(this.runtime);
		return tasks.length ? tasks.map(taskLine).join("\n\n") : "No background tasks.";
	}

	async open(ctx: ExtensionCommandContext | ExtensionContext, initialId?: string, pane: Pane = "tasks"): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(this.listText(), "info");
			return;
		}
		await ctx.ui.custom(
			(tui, theme, _keys, done) => {
				let selectedId = initialId ?? visibleTasks(this.runtime)[0]?.id;
				let focus = pane;
				let taskScroll = 0;
				let outputScroll = 0;
				let follow = true;
				const outputFingerprint = (): string =>
					visibleTasks(this.runtime)
						.map(
							(task) =>
								`${task.id}:${task.status}:${task.lastOutputAt ?? task.updatedAt}:${this.runtime.output(task.id)?.length ?? 0}`,
						)
						.join("|");
				let lastOutputFingerprint = outputFingerprint();
				let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
					const fingerprint = outputFingerprint();
					if (fingerprint === lastOutputFingerprint) return;
					lastOutputFingerprint = fingerprint;
					tui.requestRender();
				}, 1000);
				timer.unref?.();

				const selected = (): TaskSnapshot | undefined => {
					const tasks = visibleTasks(this.runtime);
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
					const tasks = visibleTasks(this.runtime);
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
							this.runtime.stop(selectedId, "user");
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
						const tasks = visibleTasks(this.runtime);
						const task = selected();
						syncOutput();
						const running = tasks.filter((item) => item.status === "running").length;
						const result = [
							theme.fg("muted", `${running} running · ${tasks.length - running} finished`),
							theme.fg(
								"dim",
								"[tab] pane · [↑↓] move · [shift+↑/↓] page · [f] follow · [s] stop · [c] clear · [q] close",
							),
							"",
						];
						if (!tasks.length) {
							result.push(theme.fg("dim", "No background tasks yet. Use /bg run <command> or background_task."));
							return frame(result, width, theme, "Background tasks");
						}

						const contentWidth = Math.max(1, width - 4);
						const leftWidth = Math.max(30, Math.min(42, Math.floor(contentWidth * 0.34)));
						const rightWidth = Math.max(24, contentWidth - leftWidth - 3);
						const left = [theme.fg(focus === "tasks" ? "accent" : "muted", theme.bold(`Tasks (${tasks.length})`)), ""];
						for (const item of tasks.slice(taskScroll, taskScroll + TASK_ROWS)) {
							left.push(
								`${item.id === task?.id ? theme.fg("accent", "→") : "·"} ${item.id} ${theme.fg("dim", taskStatus(item))}`,
							);
							left.push(`  ${oneLine(item.title)}`);
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
							right.push(`${theme.fg("muted", "Heartbeat")}: every ${duration(task.heartbeatMs)}`);
							right.push(`${theme.fg("muted", "Command")}: ${oneLine(task.command)}`);
							right.push(`${theme.fg("muted", "Cwd")}: ${task.cwd}`);
							right.push(`${theme.fg("muted", "Log")}: ${task.logFile}`, "", theme.fg("accent", theme.bold("Output")));
							right.push(...output.slice(outputScroll, outputScroll + OUTPUT_ROWS));
						}
						for (let row = 0; row < Math.max(left.length, right.length); row++) {
							result.push(
								`${pad(left[row] ?? "", leftWidth)}${theme.fg("dim", " │ ")}${truncateToWidth(right[row] ?? "", rightWidth)}`,
							);
						}
						return frame(result, width, theme, "Background tasks");
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
