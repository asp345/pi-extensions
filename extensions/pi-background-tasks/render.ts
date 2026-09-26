import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BackgroundRuntime, TaskEvent, TaskSnapshot } from "./runtime.ts";

export type TaskKind = "running" | "done" | "failed" | "stopped";

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

export function taskKind(task: TaskSnapshot): TaskKind {
	if (task.status === "running") return "running";
	if (task.timedOut || task.status === "failed") return "failed";
	if (task.status === "stopped") return "stopped";
	return "done";
}

export function taskIcon(task: TaskSnapshot, theme: Theme): string {
	switch (taskKind(task)) {
		case "running":
			return theme.bold("◈");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("dim", "•");
	}
}

export function elapsed(task: TaskSnapshot, now = Date.now()): number {
	return (task.status === "running" ? now : task.updatedAt) - task.startedAt;
}

export function eventText(event: TaskEvent): string {
	if (event.type === "running")
		return `Background task ${event.task.id} is still running (${duration(Date.now() - event.task.startedAt)} elapsed).`;
	return `Background task ${event.task.id} finished (${taskStatus(event.task)}) after ${duration(event.task.updatedAt - event.task.startedAt)}.`;
}

export function taskLine(task: TaskSnapshot): string {
	return `${task.id} · ${taskStatus(task)} · pid ${task.pid} · ${oneLine(task.command)} · ${relative(task.lastOutputAt ?? task.updatedAt)}`;
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

export function visibleTasks(runtime: BackgroundRuntime): TaskSnapshot[] {
	return runtime.list().filter((task) => task.notify);
}
