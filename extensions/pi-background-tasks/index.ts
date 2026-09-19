import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { type CompactSummary, compactCallLine } from "pi-compact-ui";
import { Type } from "typebox";
import { buildSessionEnv, registerHybridBash } from "./bash.ts";
import { BACKGROUND_TASKS_STATE_EVENT } from "./events.ts";
import { duration, oneLine, taskLine } from "./render.ts";
import { BackgroundRuntime, resolveTimeoutMs, type TaskSnapshot, tail } from "./runtime.ts";
import { BackgroundUI, COMMAND, MESSAGE, renderTaskEvent, SHORTCUT } from "./ui.ts";

const NO_MATCH = "No background task matched that id.";

function result(text: string, isError = false): AgentToolResult<unknown> & { isError?: boolean } {
	return { content: [{ type: "text", text: tail(text, 8_000) }], details: {}, isError };
}

function startedText(task: TaskSnapshot): string {
	return `Started ${task.id} (pid ${task.pid}).`;
}

function stoppingText(id: string): string {
	return `Stopping ${id}.`;
}

interface BackgroundTaskParams {
	action: "start" | "list" | "read" | "stop" | "clear";
	command?: string;
	id?: string;
}

function taskCallSummary(params: BackgroundTaskParams, runtime: BackgroundRuntime): CompactSummary {
	if (params.action === "start") {
		return { name: "launch", content: oneLine(params.command?.trim() || "…") };
	}
	if (params.action === "list") {
		const count = runtime.list().filter((task) => task.notify).length;
		return { name: "list", content: count === 0 ? "no tasks" : `${count} task${count === 1 ? "" : "s"}` };
	}
	if (params.action === "clear") {
		return { name: "clear", content: "finished tasks" };
	}
	const id = params.id?.trim() ?? "";
	const task = runtime.get(id || undefined);
	if (!task) return { name: params.action, content: id || "…" };
	const elapsed = task.status === "running" ? Date.now() - task.startedAt : task.updatedAt - task.startedAt;
	const meta = `${oneLine(task.command)} · ${duration(elapsed)}`;
	if (params.action === "read" && task.status !== "running") {
		return { name: "done", content: `${id} · ${meta}` };
	}
	return { name: params.action, content: `${id} · ${meta}` };
}

function firstText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first && "text" in first ? first.text : "";
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	let ui: BackgroundUI;
	const publishState = (runningTaskIds: readonly string[]): void => {
		pi.events.emit(BACKGROUND_TASKS_STATE_EVENT, { runningTaskIds });
	};
	const runtime = new BackgroundRuntime(
		(event) => ui.handleEvent(event),
		() => ui.refresh(),
		publishState,
	);
	ui = new BackgroundUI(pi, runtime);
	registerHybridBash(pi, runtime);

	const clearedText = (): string => `Removed ${runtime.clear()} finished background task(s).`;

	const attach = (_event: unknown, ctx: ExtensionContext): void => {
		runtime.activate();
		ui.attach(ctx);
		publishState(runtime.runningNotifiedTaskIds());
	};
	pi.on("session_start", attach);
	pi.on("agent_settled", async () => ui.flushEvents());
	pi.registerMessageRenderer(MESSAGE, renderTaskEvent);
	pi.on("session_shutdown", () => {
		runtime.shutdown();
		ui.clearWidget();
	});

	pi.registerTool({
		name: "background_task",
		label: "Background Task",
		description:
			"Start, list, read, stop, or clear background shell tasks. Completion is delivered as a steering message at the next turn boundary, or starts a turn when the parent is idle. While a task runs, a still-running notification is delivered at the heartbeat interval (default 30 minutes).",
		promptSnippet: "Run and manage background shell tasks",
		promptGuidelines: [
			"After starting a background_task, continue independent work or end the turn; completion will be delivered and wake you again. Never run sleep command or poll Do other jobs or end the turn.",
			"Use list or read only when you need status or output before completion arrives.",
			"Do not detach processes (nohup, trailing &, disown, setsid, tmux/screen) unless the user explicitly allows it. Run the command normally; it is already a managed background task.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("list"),
				Type.Literal("read"),
				Type.Literal("stop"),
				Type.Literal("clear"),
			]),
			command: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			heartbeat: Type.Optional(
				Type.Number({ description: "Minutes between still-running notifications while the task runs (default 30)" }),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds. Kills the task after this time. Optional. No default timeout.",
				}),
			),
		}),
		async execute(_callId, params, _signal, _update, ctx) {
			if (params.action === "start") {
				const command = params.command?.trim();
				if (!command) return result("command is required for action=start.", true);
				const heartbeat = params.heartbeat;
				if (heartbeat !== undefined && (!Number.isFinite(heartbeat) || heartbeat <= 0))
					return result("heartbeat must be a positive number of minutes.", true);
				try {
					resolveTimeoutMs(params.timeout);
				} catch (error) {
					return result(error instanceof Error ? error.message : "Invalid timeout.", true);
				}
				const task = runtime.start(command, ctx.cwd, {
					heartbeatMs: heartbeat === undefined ? undefined : heartbeat * 60_000,
					timeout: params.timeout,
					env: buildSessionEnv(ctx),
				});
				return result(
					`${startedText(task)} Completion is delivered as steering at the next turn boundary; DO NOT sleep or poll to wait.`,
				);
			}
			if (params.action === "list") {
				const tasks = runtime
					.list()
					.filter((task) => task.notify)
					.slice(0, 50);
				return result(tasks.length ? tasks.map(taskLine).join("\n") : "No background tasks.");
			}
			if (params.action === "clear") return result(clearedText());
			const id = params.id?.trim();
			if (!id) return result(`id is required for action=${params.action}.`, true);
			if (params.action === "read") {
				const output = runtime.output(id);
				return output === undefined ? result(NO_MATCH, true) : result(tail(output) || "(empty)");
			}
			return runtime.stop(id, "agent") ? result(stoppingText(id)) : result(NO_MATCH, true);
		},
		renderCall(args, theme, context) {
			return compactCallLine("background_task", args, theme, context, taskCallSummary(args, runtime)) as Component;
		},
		renderResult(result, options, _theme, _context): Component {
			if (!options.expanded) return new Container();
			return new Text(firstText(result), 0, 0);
		},
		renderShell: "self",
	});

	pi.registerCommand(COMMAND, {
		description: "Open or manage the background-task dashboard",
		handler: async (args, ctx) => {
			ui.attach(ctx as ExtensionContext);
			const value = args.trim();
			if (!value || value === "dashboard") return ui.open(ctx);
			if (value === "list" || value === "status") return ctx.ui.notify(ui.listText(), "info");
			if (value === "clear") return ctx.ui.notify(clearedText(), "info");
			if (value.startsWith("run ")) {
				const command = value.slice(4).trim();
				if (!command) return ctx.ui.notify("Usage: /bg run <command>", "warning");
				const task = runtime.start(command, ctx.cwd, { env: buildSessionEnv(ctx) });
				return ctx.ui.notify(startedText(task), "info");
			}
			if (value.startsWith("stop ")) {
				const id = value.slice(5).trim();
				return ctx.ui.notify(
					runtime.stop(id, "user") ? stoppingText(id) : NO_MATCH,
					runtime.get(id) ? "info" : "warning",
				);
			}
			const watch = value.match(/^(?:watch|read|log)(?:\s+--follow)?\s+(.+)$/);
			if (watch) {
				const id = watch[1]?.trim();
				if (!runtime.get(id)) return ctx.ui.notify(NO_MATCH, "warning");
				return ui.open(ctx, id, "output");
			}
			ctx.ui.notify("Usage: /bg [dashboard|list|run <command>|watch <id>|stop <id>|clear]", "warning");
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the background-task dashboard",
		handler: async (ctx) => {
			ui.attach(ctx as ExtensionContext);
			await ui.open(ctx as ExtensionContext);
		},
	});
}
