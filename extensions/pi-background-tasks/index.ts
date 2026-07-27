import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundRuntime, tail } from "./runtime.js";
import { BackgroundUI, COMMAND, SHORTCUT, taskLine } from "./ui.js";

function result(text: string, isError = false): AgentToolResult<unknown> & { isError?: boolean } {
	return { content: [{ type: "text", text: tail(text, 8_000) }], details: {}, isError } as AgentToolResult<unknown> & {
		isError?: boolean;
	};
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	let ui: BackgroundUI;
	const runtime = new BackgroundRuntime(
		(event) => ui.handleEvent(event),
		() => ui.refresh(),
	);
	ui = new BackgroundUI(pi, runtime);

	const attach = (_event: unknown, ctx: ExtensionContext): void => {
		runtime.activate();
		ui.attach(ctx);
	};
	pi.on("session_start", attach);
	pi.on("agent_settled", async () => ui.flushExits());
	pi.on("session_shutdown", () => {
		runtime.shutdown();
		ui.clearWidget();
	});

	pi.registerTool({
		name: "background_task",
		label: "Background Task",
		description:
			"Start, list, read, stop, or clear background shell tasks. Completion arrives as a follow-up that resumes the parent automatically.",
		promptSnippet: "Run and manage background shell tasks",
		promptGuidelines: [
			"After starting a background_task, continue independent work or end the turn; completion arrives as a follow-up that resumes you automatically. Do not sleep or poll to wait.",
			"Use list or read only when you need status or output before completion arrives.",
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
		}),
		async execute(_callId, params, _signal, _update, ctx) {
			if (params.action === "start") {
				const command = params.command?.trim();
				if (!command) return result("command is required for action=start.", true);
				const task = runtime.start(command, ctx.cwd);
				return result(
					`Started ${task.id} (pid ${task.pid}). Completion arrives as a follow-up and resumes you automatically; do not sleep or poll to wait.`,
				);
			}
			if (params.action === "list") {
				const tasks = runtime.list().slice(0, 50);
				return result(tasks.length ? tasks.map(taskLine).join("\n") : "No background tasks.");
			}
			if (params.action === "clear") return result(`Removed ${runtime.clear()} finished background task(s).`);
			if (!params.id?.trim()) return result(`id is required for action=${params.action}.`, true);
			if (params.action === "read") {
				const output = runtime.output(params.id.trim());
				return output === undefined
					? result("No background task matched that id.", true)
					: result(tail(output) || "(empty)");
			}
			return runtime.stop(params.id.trim())
				? result(`Stopping ${params.id.trim()}.`)
				: result("No background task matched that id.", true);
		},
	});

	pi.registerCommand(COMMAND, {
		description: "Open or manage the background-task dashboard",
		handler: async (args, ctx) => {
			ui.attach(ctx as ExtensionContext);
			const value = args.trim();
			if (!value || value === "dashboard") return ui.open(ctx);
			if (value === "list" || value === "status") return ctx.ui.notify(ui.listText(), "info");
			if (value === "clear") return ctx.ui.notify(`Removed ${runtime.clear()} finished background task(s).`, "info");
			if (value.startsWith("run ")) {
				const command = value.slice(4).trim();
				if (!command) return ctx.ui.notify("Usage: /bg run <command>", "warning");
				const task = runtime.start(command, ctx.cwd);
				return ctx.ui.notify(`Started ${task.id} (pid ${task.pid}).`, "info");
			}
			if (value.startsWith("stop ")) {
				const id = value.slice(5).trim();
				return ctx.ui.notify(
					runtime.stop(id) ? `Stopping ${id}.` : "No background task matched that id.",
					runtime.get(id) ? "info" : "warning",
				);
			}
			const watch = value.match(/^(?:watch|read|log)(?:\s+--follow)?\s+(.+)$/);
			if (watch) {
				const id = watch[1]?.trim();
				if (!runtime.get(id)) return ctx.ui.notify("No background task matched that id.", "warning");
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

export { BackgroundRuntime } from "./runtime.js";
