import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MessageLines } from "../shared/ui.ts";
import { childMessageContent, type NoticeKind, noticeContent } from "./delegation.ts";
import { SUBAGENTS_STATE_EVENT } from "./events.ts";
import { SubagentManager } from "./manager.ts";
import { parseStoredRecord, restoreRecord, STATE_KIND, storeRecord } from "./state.ts";
import { formatRecord, registerSubagentTools } from "./tools.ts";
import type { StoredAgent } from "./types.ts";
import { AgentsUI, COMMAND, SHORTCUT } from "./ui.ts";

const MESSAGE_KIND = "subagent-message";
const NOTICE_KIND = "subagent-notice";

interface MessageDetails {
	id: string;
	name: string;
	message: string;
}

interface NoticeDetails {
	id: string;
	name: string;
	kind: NoticeKind;
	body?: string;
}

const NOTICE_LABELS: Record<NoticeKind, string> = {
	"no-reply": "Subagent finished without reply",
	failed: "Subagent failed",
	cancelled: "Subagent stopped",
};

export default function subagents(pi: ExtensionAPI): void {
	const manager: SubagentManager = new SubagentManager({
		changed: () => {
			ui.update();
			const runningAgentIds = manager
				.list()
				.filter((record) => record.running)
				.map((record) => record.id);
			pi.events.emit(SUBAGENTS_STATE_EVENT, { runningAgentIds });
		},
		persist: (record) => pi.appendEntry(STATE_KIND, storeRecord(record)),
		message: (record, message) =>
			pi.sendMessage<MessageDetails>(
				{
					customType: MESSAGE_KIND,
					content: childMessageContent(record.name, message),
					display: true,
					details: { id: record.id, name: record.name, message },
				},
				{ deliverAs: "steer", triggerTurn: true },
			),
		notice: (record, kind, body) =>
			pi.sendMessage<NoticeDetails>(
				{
					customType: NOTICE_KIND,
					content: noticeContent(kind, record.name, body),
					display: true,
					details: { id: record.id, name: record.name, kind, body },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			),
	});
	const ui = new AgentsUI(manager);

	registerSubagentTools(pi, manager);

	pi.registerMessageRenderer<MessageDetails>(MESSAGE_KIND, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		return new MessageLines(
			[
				{
					marker: theme.fg("accent", "◆"),
					label: "Agent message received",
					meta: [`child:${details.name}`],
					body: options.expanded ? details.message : undefined,
				},
			],
			"customMessageText",
			theme,
		);
	});

	pi.registerMessageRenderer<NoticeDetails>(NOTICE_KIND, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		return new MessageLines(
			[
				{
					marker: theme.fg(details.kind === "failed" ? "error" : "warning", "◆"),
					label: NOTICE_LABELS[details.kind],
					meta: [`child:${details.name}`],
					body: options.expanded ? details.body : undefined,
				},
			],
			"customMessageText",
			theme,
		);
	});

	pi.registerCommand(COMMAND, {
		description: "Open the subagent dashboard, list subagents, or stop one",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) return ui.open(ctx);
			if (value === "list") {
				const records = manager.list();
				return ctx.ui.notify(records.length ? records.map(formatRecord).join("\n\n") : "No subagents.", "info");
			}
			if (value.startsWith("stop ")) {
				const ref = value.slice(5).trim();
				const record = manager.find(ref);
				if (!record) return ctx.ui.notify(`No subagent matched ${ref}. Available: ${manager.describe()}.`, "warning");
				const stopped = manager.stop(record, "user");
				return ctx.ui.notify(stopped ? `Stopping ${record.name}.` : `${record.name} is not running.`, "info");
			}
			ctx.ui.notify(`Usage: /${COMMAND} [list|stop <name|id>]`, "warning");
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the subagent dashboard",
		handler: async (ctx) => ui.open(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		const latest = new Map<string, StoredAgent>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KIND) continue;
			const stored = parseStoredRecord(entry.data);
			if (stored) latest.set(stored.id, stored);
		}
		manager.restore([...latest.values()].map(restoreRecord));
		ui.attach(ctx);
	});

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
		ui.detach();
	});
}
