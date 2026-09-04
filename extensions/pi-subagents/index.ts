import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { definitionSummary, discoverDefinitions, resolveDefinition } from "./definitions.ts";
import { bounded, type CompletionDetails, completionDetails } from "./format.ts";
import { AgentManager } from "./manager.ts";
import { NotificationQueue } from "./notifications.ts";
import { parseStoredRecord, type StoredAgentState, storeRecord } from "./state.ts";
import { registerSubagentTools } from "./tools.ts";
import type { AgentRecord, DefinitionRegistry } from "./types.ts";
import { AgentsUI } from "./ui.ts";

export { delegationPrompt } from "./delegation.ts";

const NOTIFICATION_BYTES = 1_200;
const STATE_KIND = "pi-subagent-state";

interface SubagentReportDetails {
	id: string;
	type: string;
	title: string;
	summary: string;
}

interface CompletionBatchDetails {
	records: CompletionDetails[];
}

export default function subagents(pi: ExtensionAPI): void {
	let registry: DefinitionRegistry = { definitions: new Map(), errors: [] };
	let currentContext: ExtensionContext | undefined;
	let shuttingDown = false;
	const pendingNotifications = new NotificationQueue<number>((batch) => deliverNotifications(batch));
	let ui: AgentsUI;
	const manager = new AgentManager(
		() => ui?.updateWidget(),
		(record) => notifyCompletion(record),
		(record) => pendingNotifications.delete(record.id),
		(record, reason) => {
			const summary = reason.replace(/\s+/gu, " ").trim();
			currentContext?.ui.notify(
				`${record.type} switched to fallback model ${record.model ?? "configured"}: ${summary.slice(0, 240)}`,
				"warning",
			);
		},
		(record, summary) => {
			const content = bounded(summary, 4_000, 80).text;
			pi.sendMessage<SubagentReportDetails>(
				{
					customType: "subagent-report",
					content: `Progress report from ${record.id} (${record.type}, ${record.title}):\n${content}`,
					display: true,
					details: { id: record.id, type: record.type, title: record.title, summary: content },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		},
		(record) => {
			if (currentContext && manager.get(record.id) === record) pi.appendEntry(STATE_KIND, storeRecord(record));
		},
	);
	ui = new AgentsUI(manager);

	registerSubagentTools(pi, {
		manager,
		registry: () => registry,
		clearPendingNotifications: (id) => pendingNotifications.delete(id),
	});

	function restoreRecords(ctx: ExtensionContext): AgentRecord[] {
		const latest = new Map<string, StoredAgentState>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KIND) continue;
			const state = parseStoredRecord(entry.data);
			if (state) latest.set(state.id, state);
		}
		return [...latest.values()].flatMap((state) => {
			if (!resolveDefinition(registry, state.type)) return [];
			return [
				{
					...state,
					status: state.status === "running" ? "stopped" : state.status,
					abortController: new AbortController(),
					pendingSteers: [],
				} satisfies AgentRecord,
			];
		});
	}

	function notifyCompletion(record: AgentRecord): void {
		ui.updateWidget();
		if (shuttingDown || !record.background || record.resultConsumed) return;
		pendingNotifications.enqueue(record.id, record.completedAt ?? Date.now());
		currentContext?.ui.notify(
			`${record.type} ${record.status} (${record.id.slice(0, 8)}).`,
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
		const perResult = Math.max(200, Math.floor((NOTIFICATION_BYTES - 300) / records.length));
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
					return `\n${record.id} (${record.type}) ${record.status}${record.usedFallback ? ` via fallback model ${record.model ?? "configured"}` : ""}:\n${bounded(message, perResult, 12).text}`;
				}),
				"\nUse get_subagent_result for bounded transcript retrieval.",
			].join("\n"),
			NOTIFICATION_BYTES,
			60,
		).text;
		pi.sendMessage<CompletionBatchDetails>(
			{
				customType: "subagent-completion",
				content,
				display: true,
				details: { records: records.map(completionDetails) },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	pi.registerMessageRenderer<SubagentReportDetails>("subagent-report", (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		box.addChild(
			new Text(
				`${theme.fg("toolTitle", theme.bold(`Report from ${details.type}`))} ${theme.fg("dim", details.title)}\n${theme.fg("toolOutput", details.summary)}`,
				0,
				0,
			),
		);
		return box;
	});

	pi.registerMessageRenderer<CompletionBatchDetails>("subagent-completion", (message, _options, theme) => {
		const records = message.details?.records;
		if (!records?.length) return undefined;
		const failed = records.some((record) => record.status !== "completed");
		const label = records.length === 1 ? records[0]?.type : `${records.length} subagents`;
		const stats = records
			.map(
				(record) =>
					`${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools${record.usedFallback ? " · fallback" : ""}`,
			)
			.join("; ");
		return new Text(
			`${theme.fg(failed ? "warning" : "success", failed ? "!" : "✓")} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("dim", stats)}`,
			0,
			0,
		);
	});

	pi.registerCommand("agents", {
		description: "Choose the active subagent context shown above the editor",
		handler: async (args, ctx) => ui.open(ctx, args),
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		currentContext = ctx;
		registry = discoverDefinitions(ctx.cwd, ctx.isProjectTrusted());
		manager.restore(restoreRecords(ctx));
		ui.attach(ctx);
		if (registry.errors.length)
			ctx.ui.notify(`${registry.errors.length} agent definition configuration error(s).`, "warning");
	});
	pi.on("before_agent_start", (event) => {
		const summary = definitionSummary(registry);
		const warning = registry.errors.length ? "\nSome definitions have configuration errors; inspect /agents." : "";
		return { systemPrompt: `${event.systemPrompt}\n\n# Available subagents\n${summary || "None"}${warning}` };
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
