import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundRuntime, TaskEvent, TaskSnapshot } from "./runtime.ts";

export type Pane = "tasks" | "output";

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
	if (task.timedOut) return "timed out";
	if (task.status === "running") return "running";
	if (task.status === "stopped") {
		if (task.stopReason === "user") return "stopped by user";
		if (task.stopReason === "agent") return "stopped by agent";
		if (task.stopReason === "shutdown") return "stopped on shutdown";
		return "stopped";
	}
	return `${task.status} (exit ${task.exitCode ?? "?"})`;
}

export function eventText(event: TaskEvent): string {
	if (event.type === "running")
		return `Background task ${event.task.id} is still running (${duration(Date.now() - event.task.startedAt)} elapsed).`;
	return `Background task ${event.task.id} finished (${taskStatus(event.task)}) after ${duration(event.task.updatedAt - event.task.startedAt)}.`;
}

export function taskLine(task: TaskSnapshot): string {
	return `${task.id} · ${taskStatus(task)} · pid ${task.pid} · ${oneLine(task.title)} · ${relative(task.lastOutputAt ?? task.updatedAt)}`;
}

export function oneLine(text: string): string {
	return text.replace(/\s*[\r\n]+\s*/g, " ⏎ ").trim();
}

export function lastOutputLine(output: string | undefined): string {
	if (!output) return "";
	return (
		output
			.split(/[\r\n]+/)
			.filter((line) => line.trim())
			.pop() ?? ""
	);
}

export function pad(text: string, width: number): string {
	const value = truncateToWidth(text, width);
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function frame(lines: string[], width: number, theme: Theme, title: string): string[] {
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

export function visibleTasks(runtime: BackgroundRuntime): TaskSnapshot[] {
	return runtime.list().filter((task) => task.notify);
}

export function eventLines(event: TaskEvent, theme: Theme, expanded: boolean): string[] {
	const running = event.type === "running";
	const lines = [
		theme.fg(
			running ? "accent" : "success",
			theme.bold(running ? "Background task still running" : "Background task finished"),
		),
		`${theme.fg("muted", "Task")}: ${event.task.id} · ${oneLine(event.task.title)}`,
		`${theme.fg("muted", "Status")}: ${taskStatus(event.task)} · pid ${event.task.pid}`,
		`${theme.fg("muted", "Started")}: ${relative(event.task.startedAt)} · ${duration(Date.now() - event.task.startedAt)} elapsed`,
		`${theme.fg("muted", "Command")}: ${oneLine(event.task.command)}`,
		`${theme.fg("muted", "Log")}: ${event.task.logFile}`,
		"",
		theme.fg("accent", theme.bold("Recent output")),
	];
	const output = event.output.trim() ? event.output.split(/\r?\n/) : ["(no output yet)"];
	lines.push(...(expanded ? output : output.slice(-8)));
	if (!expanded && output.length > 8) lines.push(theme.fg("dim", "Expand to inspect more output."));
	return lines;
}
