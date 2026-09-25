import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { childMessageContent, type NoticeKind, noticeContent } from "./delegation.ts";
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

class AgentMessageLine implements Component {
	constructor(
		private readonly marker: string,
		private readonly label: string,
		private readonly participant: string,
		private readonly body: string | undefined,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		const header = [`${this.marker} ${theme.fg("muted", this.label)}`, theme.fg("dim", this.participant)].join(
			theme.fg("dim", " · "),
		);
		const lines = [truncateToWidth(` ${header}`, width, "…")];
		if (!this.body) return lines;
		const textWidth = Math.max(1, width - 4);
		const wrapped = this.body.split("\n").flatMap((line) => {
			const parts = wrapTextWithAnsi(line, textWidth);
			return parts.length > 0 ? parts : [""];
		});
		wrapped.forEach((line, index) => {
			const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
			lines.push(truncateToWidth(` ${prefix}${theme.fg("customMessageText", line)}`, width, ""));
		});
		return lines;
	}

	invalidate(): void {}
}

export default function subagents(pi: ExtensionAPI): void {
	const manager: SubagentManager = new SubagentManager({
		changed: () => ui.update(),
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
		return new AgentMessageLine(
			theme.fg("accent", "◆"),
			"Agent message received",
			`child:${details.name}`,
			options.expanded ? details.message : undefined,
			theme,
		);
	});

	pi.registerMessageRenderer<NoticeDetails>(NOTICE_KIND, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		return new AgentMessageLine(
			theme.fg(details.kind === "failed" ? "error" : "warning", "◆"),
			NOTICE_LABELS[details.kind],
			`child:${details.name}`,
			options.expanded ? details.body : undefined,
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
