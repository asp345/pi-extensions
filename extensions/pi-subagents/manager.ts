import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeChildSession, createChildSession } from "./child.ts";
import { type NoticeKind, parentMessagePrompt, preview } from "./delegation.ts";
import type { AgentRecord, ThinkingLevel } from "./types.ts";

export interface ManagerHooks {
	changed(): void;
	persist(record: AgentRecord): void;
	message(record: AgentRecord, message: string): void;
	notice(record: AgentRecord, kind: NoticeKind, body: string | undefined): void;
}

export interface LaunchInput {
	name: string;
	prompt: string;
	model?: Model<Api>;
	thinking?: ThinkingLevel;
}

export type SendOutcome = "steered" | "started" | "resumed";

function childSessionDir(parentSessionFile: string): string {
	return join(dirname(parentSessionFile), `${basename(parentSessionFile, ".jsonl")}.subagents`);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function finalError(session: AgentSession): string | undefined {
	const last = session.messages.findLast((message) => message.role === "assistant");
	if (last?.role !== "assistant") return undefined;
	if (last.stopReason === "error") return last.errorMessage?.trim() || "provider error";
	if (last.stopReason === "aborted") return last.errorMessage?.trim() || "aborted";
	return undefined;
}

function activityOf(event: AgentSessionEvent): string | undefined {
	switch (event.type) {
		case "message_update": {
			const kind = event.assistantMessageEvent.type;
			if (kind.startsWith("thinking")) return "Thinking";
			if (kind.startsWith("text")) return "Writing";
			if (kind.startsWith("toolcall")) return "Writing tool call";
			return undefined;
		}
		case "tool_execution_start":
			return `Running ${event.toolName}`;
		case "compaction_start":
			return "Compacting";
		case "auto_retry_start":
			return `Retrying ${event.attempt}/${event.maxAttempts}`;
		case "tool_execution_end":
		case "compaction_end":
		case "auto_retry_end":
		case "message_end":
			return "Waiting";
		default:
			return undefined;
	}
}

export class SubagentManager {
	private readonly records = new Map<string, AgentRecord>();
	private readonly stopRequests = new Map<string, "parent" | "user">();
	private closed = false;

	constructor(private readonly hooks: ManagerHooks) {}

	restore(records: AgentRecord[]): void {
		this.records.clear();
		this.stopRequests.clear();
		this.closed = false;
		for (const record of records) this.records.set(record.id, record);
		this.hooks.changed();
	}

	list(): AgentRecord[] {
		return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	find(ref: string): AgentRecord | undefined {
		const needle = ref.trim().toLowerCase();
		if (!needle) return undefined;
		const records = this.list();
		const byName = records.find((record) => record.name.toLowerCase() === needle);
		if (byName) return byName;
		const byId = records.filter((record) => record.id.toLowerCase().startsWith(needle));
		return byId.length === 1 ? byId[0] : undefined;
	}

	describe(): string {
		const records = this.list();
		return records.length ? records.map((record) => `${record.name} (${record.id})`).join(", ") : "none";
	}

	async launch(ctx: ExtensionContext, input: LaunchInput): Promise<AgentRecord> {
		const lower = input.name.toLowerCase();
		if (this.list().some((record) => record.name.toLowerCase() === lower)) {
			throw new Error(`A subagent named ${input.name} already exists. Use send_message to give it more work.`);
		}
		const now = Date.now();
		const record: AgentRecord = {
			id: randomUUID(),
			name: input.name,
			prompt: input.prompt,
			cwd: ctx.cwd,
			thinking: input.thinking,
			createdAt: now,
			updatedAt: now,
			cost: 0,
			running: false,
			repliesThisRun: 0,
			backgroundTasks: [],
		};
		this.records.set(record.id, record);
		let session: AgentSession;
		try {
			session = await this.open(ctx, record, input.model, input.thinking);
		} catch (error) {
			this.records.delete(record.id);
			this.hooks.changed();
			throw error;
		}
		this.startRun(record, session, record.prompt);
		return record;
	}

	async send(ctx: ExtensionContext, record: AgentRecord, message: string): Promise<SendOutcome> {
		const text = parentMessagePrompt(message);
		if (record.session?.isStreaming) {
			await record.session.steer(text);
			return "steered";
		}
		const resumed = !record.session;
		const session = await this.open(ctx, record);
		this.startRun(record, session, text);
		return resumed ? "resumed" : "started";
	}

	stop(record: AgentRecord, by: "parent" | "user"): boolean {
		const session = record.session;
		if (!record.running || !session) return false;
		this.stopRequests.set(record.id, by);
		void this.close(record, session).then(() => this.finishEpisode(record, session));
		return true;
	}

	async shutdown(): Promise<void> {
		const records = this.list();
		this.closed = true;
		await Promise.allSettled(
			records.map(async (record) => {
				const session = record.session ?? (await record.opening?.catch(() => undefined));
				if (!session) return record.closing;
				await this.close(record, session);
				record.cost = session.getSessionStats().cost;
				record.lastText = session.getLastAssistantText() ?? record.lastText;
				record.running = false;
				record.activity = undefined;
				record.updatedAt = Date.now();
				this.hooks.persist(record);
			}),
		);
		this.records.clear();
		this.hooks.changed();
	}

	private close(record: AgentRecord, session: AgentSession): Promise<void> {
		if (record.session === session) record.session = undefined;
		const closing = closeChildSession(session).catch(() => undefined);
		record.closing = closing;
		return closing;
	}

	private open(
		ctx: ExtensionContext,
		record: AgentRecord,
		model?: Model<Api>,
		thinking?: ThinkingLevel,
	): Promise<AgentSession> {
		if (record.session) return Promise.resolve(record.session);
		record.opening ??= this.createSession(ctx, record, model, thinking).finally(() => {
			record.opening = undefined;
		});
		return record.opening;
	}

	private async createSession(
		ctx: ExtensionContext,
		record: AgentRecord,
		model: Model<Api> | undefined,
		thinking: ThinkingLevel | undefined,
	): Promise<AgentSession> {
		await record.closing;
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const session = await createChildSession({
			cwd: record.cwd,
			trusted: ctx.isProjectTrusted(),
			sessionFile: record.sessionFile,
			sessionDir: parentSessionFile ? childSessionDir(parentSessionFile) : undefined,
			parentSessionFile,
			model,
			thinking,
			sendToParent: (message) => {
				record.repliesThisRun += 1;
				this.hooks.message(record, message);
			},
			onBackgroundTasks: (runningTaskIds) => this.setBackgroundTasks(record, runningTaskIds),
			onExtensionError: (message) => {
				record.lastError = message;
				this.hooks.changed();
			},
		});
		if (!record.sessionFile) session.setSessionName(record.name);
		record.session = session;
		record.sessionFile = session.sessionFile;
		if (session.model) record.model = `${session.model.provider}/${session.model.id}`;
		record.thinking = session.thinkingLevel;
		session.subscribe((event) => this.observe(record, session, event));
		this.touch(record);
		return session;
	}

	private observe(record: AgentRecord, session: AgentSession, event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.startEpisode(record);
			return;
		}
		if (event.type === "agent_settled") {
			if (record.backgroundTasks.length === 0) this.finishEpisode(record, session);
			else this.setActivity(record, `Waiting for ${record.backgroundTasks.join(", ")}`);
			return;
		}
		if (!record.running) return;
		if (event.type === "message_end") record.cost = session.getSessionStats().cost;
		const activity = activityOf(event);
		if (activity !== undefined) this.setActivity(record, activity);
	}

	private setBackgroundTasks(record: AgentRecord, runningTaskIds: string[]): void {
		record.backgroundTasks = runningTaskIds;
		if (record.running && record.session && !record.session.isStreaming && runningTaskIds.length > 0) {
			this.setActivity(record, `Waiting for ${runningTaskIds.join(", ")}`);
		}
	}

	private setActivity(record: AgentRecord, activity: string): void {
		if (activity === record.activity) return;
		record.activity = activity;
		this.hooks.changed();
	}

	private startEpisode(record: AgentRecord): void {
		if (record.running) return;
		record.running = true;
		record.runStartedAt = Date.now();
		record.repliesThisRun = 0;
		record.activity = "Waiting";
		record.lastError = undefined;
		this.stopRequests.delete(record.id);
		this.touch(record);
	}

	private startRun(record: AgentRecord, session: AgentSession, text: string): void {
		this.startEpisode(record);
		session
			.prompt(text, { expandPromptTemplates: false, source: "extension", streamingBehavior: "steer" })
			.catch((error: unknown) => this.finishEpisode(record, session, errorText(error)));
	}

	private finishEpisode(record: AgentRecord, session: AgentSession, thrown?: string): void {
		const stop = this.stopRequests.get(record.id);
		this.stopRequests.delete(record.id);
		if (!record.running || this.closed) return;
		record.running = false;
		record.runStartedAt = undefined;
		record.activity = undefined;
		record.cost = session.getSessionStats().cost;
		record.lastText = session.getLastAssistantText() ?? record.lastText;
		if (stop) {
			if (stop === "user") this.hooks.notice(record, "cancelled", "Stopped by the user. The session is kept.");
		} else {
			const error = thrown ?? finalError(session);
			if (error) {
				record.lastError = error;
				this.hooks.notice(record, "failed", error);
			} else if (record.repliesThisRun === 0) {
				this.hooks.notice(record, "no-reply", preview(record.lastText));
			}
		}
		this.touch(record);
		if (record.session === session) void Promise.resolve().then(() => this.close(record, session));
	}

	private touch(record: AgentRecord): void {
		record.updatedAt = Date.now();
		this.hooks.changed();
		this.hooks.persist(record);
	}
}
