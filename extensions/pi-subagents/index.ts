import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { bounded, type CompletionDetails, completionDetails, RESULT_BYTES, RESULT_LINES } from "./format.ts";
import { AgentManager } from "./manager.ts";
import { NotificationQueue } from "./notifications.ts";
import { parseStoredRecord, type StoredAgentState, storeRecord } from "./state.ts";
import { registerSubagentTools } from "./tools.ts";
import type { AgentRecord } from "./types.ts";
import { AgentsUI, COMMAND, SHORTCUT } from "./ui.ts";

export { delegationPrompt } from "./delegation.ts";

const NOTIFICATION_BYTES = 1_200;
const STATE_KIND = "pi-subagent-state";

interface SubagentReportDetails {
	id: string;
	title: string;
	summary: string;
}

interface CompletionBatchDetails {
	records: CompletionDetails[];
}

function customText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

export default function subagents(pi: ExtensionAPI): void {
	let currentContext: ExtensionContext | undefined;
	let shuttingDown = false;
	const pendingNotifications = new NotificationQueue<number>((batch) => deliverNotifications(batch));
	let ui: AgentsUI;
	const manager = new AgentManager(
		() => ui?.updateWidget(),
		(record) => notifyCompletion(record),
		(record) => pendingNotifications.delete(record.id),
		(record, summary) => {
			const content = bounded(summary, 4_000, 80).text;
			pi.sendMessage<SubagentReportDetails>(
				{
					customType: "subagent-report",
					content: `Progress report from ${record.id} (${record.title}):\n${content}`,
					display: true,
					details: { id: record.id, title: record.title, summary: content },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		(record) => {
			if (currentContext && manager.get(record.id) === record) pi.appendEntry(STATE_KIND, storeRecord(record));
		},
	);
	ui = new AgentsUI(manager);
	ui.setResumeHandler((id) => resumeInactive(id));

	async function resumeInactive(id: string): Promise<string> {
		const ctx = currentContext;
		if (!ctx) throw new Error("No active session.");
		const record = manager.get(id);
		if (!record) throw new Error(`No subagent matched ${id.trim()}. Available: ${manager.describeIds()}.`);
		if (record.status === "running") return `Subagent ${record.id} is already running.`;
		const resumed = await manager.resume(ctx, record.id, {
			title: record.title,
			background: true,
			thinking: record.thinking,
		});
		return `Resumed subagent ${resumed.id} (${resumed.title}) in the background.`;
	}

	pi.registerCommand(COMMAND, {
		description: "Open or manage the subagent dashboard",
		handler: async (args, ctx) => {
			ui.attach(ctx as ExtensionContext);
			const value = args.trim();
			if (!value || value === "dashboard") return ui.open(ctx);
			if (value === "list" || value === "status") return ctx.ui.notify(ui.listText(), "info");
			if (value.startsWith("stop ")) {
				const id = value.slice(5).trim();
				const record = manager.get(id);
				if (!record) return ctx.ui.notify(`No subagent matched ${id}. Available: ${manager.describeIds()}.`, "warning");
				return ctx.ui.notify(
					manager.stop(record.id, false) ? `Stopping ${record.id}.` : `Subagent ${record.id} is not running.`,
					"info",
				);
			}
			if (value.startsWith("resume ")) {
				try {
					return ctx.ui.notify(await resumeInactive(value.slice(7).trim()), "info");
				} catch (error) {
					return ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
			}
			ctx.ui.notify("Usage: /agents [dashboard|list|stop <id>|resume <id>]", "warning");
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the subagent dashboard",
		handler: async (ctx) => {
			ui.attach(ctx as ExtensionContext);
			await ui.open(ctx as ExtensionContext);
		},
	});

	registerSubagentTools(pi, {
		manager,
		clearPendingNotifications: (id) => pendingNotifications.delete(id),
	});

	function restoreRecords(ctx: ExtensionContext): AgentRecord[] {
		const latest = new Map<string, StoredAgentState>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KIND) continue;
			const state = parseStoredRecord(entry.data);
			if (state) latest.set(state.id, state);
		}
		return [...latest.values()].map(
			(state) =>
				({
					...state,
					status: state.status === "running" ? "stopped" : state.status,
					completedAt: state.completedAt ?? Date.now(),
					messages: [],
					abortController: new AbortController(),
					pendingSteers: [],
				}) satisfies AgentRecord,
		);
	}

	function notifyCompletion(record: AgentRecord): void {
		ui.updateWidget();
		if (shuttingDown || !record.background || record.resultConsumed) return;
		pendingNotifications.enqueue(record.id, record.completedAt ?? Date.now());
		currentContext?.ui.notify(
			`${record.title} ${record.status} (${record.id.slice(0, 8)}).`,
			record.status === "completed" ? "info" : "warning",
		);
	}

	function deliverNotifications(pending: ReadonlyMap<string, number>): void {
		if (shuttingDown) return;
		const records = [...pending.keys()].flatMap((id) => {
			const record = manager.get(id);
			return !record || record.resultConsumed || record.status === "running" ? [] : [record];
		});
		if (!records.length) return;
		const single = records.length === 1;
		const perResult = single ? RESULT_BYTES : Math.max(200, Math.floor((NOTIFICATION_BYTES - 300) / records.length));
		const perLines = single ? RESULT_LINES : 12;
		const content = bounded(
			[
				"Background subagents finished:",
				...records.map((record) => {
					const message =
						record.status === "completed"
							? record.result || "No final answer."
							: record.status === "stopped"
								? "Agent was stopped and can be resumed."
								: record.error || "Agent failed.";
					return `\n${record.id} (${record.title}) ${record.status}:\n${bounded(message, perResult, perLines).text}`;
				}),
				"\nUse get_subagent_result for bounded transcript retrieval.",
			].join("\n"),
			single ? RESULT_BYTES + 600 : NOTIFICATION_BYTES,
			single ? RESULT_LINES + 10 : 60,
		).text;
		pi.sendMessage<CompletionBatchDetails>(
			{
				customType: "subagent-completion",
				content,
				display: true,
				details: { records: records.map(completionDetails) },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	pi.registerMessageRenderer<SubagentReportDetails>("subagent-report", (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const header = ` ${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("Subagent"))} ${theme.fg("dim", details.title)}`;
		if (!options.expanded) {
			const preview = details.summary.replace(/\s+/gu, " ").trim();
			const clipped = preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
			return new Text(
				`${header}${clipped ? theme.fg("dim", ` · ${clipped}`) : ""} ${keyHint("app.tools.expand", "to expand")}`,
				0,
				0,
			);
		}
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Markdown(details.summary, 1, 0, getMarkdownTheme()));
		return container;
	});

	pi.registerMessageRenderer<CompletionBatchDetails>("subagent-completion", (message, options, theme) => {
		const records = message.details?.records;
		if (!records?.length) return undefined;
		const failed = records.some((record) => record.status !== "completed");
		const label = records.length === 1 ? records[0]?.title : `${records.length} subagents`;
		const stats = records
			.map((record) => `${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools`)
			.join("; ");
		const header = ` ${theme.fg(failed ? "warning" : "success", failed ? "!" : "✓")} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("dim", stats)}`;
		if (!options.expanded) {
			return new Text(`${header} ${keyHint("app.tools.expand", "to expand")}`, 0, 0);
		}
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Markdown(customText(message.content), 1, 0, getMarkdownTheme()));
		return container;
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		currentContext = ctx;
		manager.restore(restoreRecords(ctx));
		ui.attach(ctx);
	});
	pi.on("session_shutdown", async () => {
		const context = currentContext;
		shuttingDown = true;
		pendingNotifications.clear();
		await manager.shutdown();
		if (context) ui.detach(context);
		currentContext = undefined;
	});
}
