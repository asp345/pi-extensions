import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearAgentContextCache } from "./context.ts";
import { openPersistedSession, resolveModels, resolveThinking, resumeSession, runNew } from "./runner.ts";
import type { AgentDefinition, AgentRecord, ThinkingLevel } from "./types.ts";
import { message, onAbort } from "./util.ts";
import { createWorktree, saveWorktree } from "./worktree.ts";

interface SpawnOptions {
	background: boolean;
	model?: string;
	maxTurns?: number;
	fork: boolean;
	signal?: AbortSignal;
}

interface ResumeOptions {
	title: string;
	background: boolean;
	model?: Model<Api>;
	models: string[];
	definition?: AgentDefinition;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	signal?: AbortSignal;
}

export class AgentManager {
	private readonly records = new Map<string, AgentRecord>();
	private renderTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly changed: () => void,
		private readonly completed: (record: AgentRecord) => void,
		private readonly resumed: (record: AgentRecord) => void,
		private readonly fallback: (record: AgentRecord, reason: string) => void,
		private readonly reported: (record: AgentRecord, summary: string) => void,
		private readonly persisted: (record: AgentRecord) => void,
		private readonly startSession: typeof runNew = runNew,
	) {}

	spawn(
		ctx: ExtensionContext,
		definition: AgentDefinition,
		title: string,
		prompt: string,
		options: SpawnOptions,
	): AgentRecord {
		const id = randomUUID();
		const record: AgentRecord = {
			id,
			type: definition.name,
			title,
			prompt,
			cwd: ctx.cwd,
			status: "running",
			background: options.background,
			startedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			model: options.model ?? definition.models[0] ?? "parent",
			models: definition.models,
			thinking: resolveThinking(definition.thinking, ctx),
			abortController: new AbortController(),
			pendingSteers: [],
		};
		this.records.set(id, record);
		this.changed();
		this.persisted(record);
		record.promise = this.run(record, ctx, definition, prompt, options);
		return record;
	}

	async resume(ctx: ExtensionContext, id: string, prompt: string, options: ResumeOptions): Promise<AgentRecord> {
		const record = this.get(id);
		if (!record) throw new Error(`Unknown or ambiguous subagent ID: ${id}`);
		if (record.status === "running") throw new Error(`Subagent ${id} is already running.`);
		const previousRun = record.promise;
		if (previousRun) await previousRun;
		if (record.promise !== previousRun) {
			throw new Error(`Subagent ${id} is already running.`);
		}
		if (!record.session && !record.sessionFile && !options.definition) {
			throw new Error(`Subagent ${id} has no resumable session.`);
		}
		record.title = options.title;
		record.prompt = prompt;
		record.background = options.background;
		record.status = "running";
		record.error = undefined;
		record.result = undefined;
		record.completedAt = undefined;
		record.abortController = new AbortController();
		if (options.model) {
			record.model = `${options.model.provider}/${options.model.id}`;
			record.usedFallback = false;
			record.fallbackReason = undefined;
		}
		record.models = options.models;
		record.thinking = options.thinking ?? record.thinking;
		record.resultConsumed = false;
		this.resumed(record);
		this.changed();
		this.persisted(record);
		const callbacks = this.callbacks(record);
		record.promise = (async () => {
			let ranNew = false;
			const detach = onAbort(options.background ? undefined : options.signal, () => record.abortController.abort());
			try {
				if (!record.session && record.sessionFile && options.definition) {
					record.session = await openPersistedSession(
						ctx,
						options.definition,
						record.sessionFile,
						record.worktree?.cwd ?? record.cwd,
						callbacks,
						record.abortController.signal,
					);
				}
				if (!record.session && options.definition) {
					ranNew = true;
					await this.run(record, ctx, options.definition, prompt, {
						background: true,
						maxTurns: options.maxTurns,
						fork: false,
						signal: record.abortController.signal,
					});
					return;
				}
				if (!record.session) throw new Error(`Subagent ${id} has no resumable session.`);
				const result = await resumeSession(record.session, prompt, {
					model: options.model,
					models: options.models.length ? () => resolveModels(options.models, ctx, options.definition) : undefined,
					thinking: options.thinking,
					maxTurns: options.maxTurns,
					signal: record.abortController.signal,
					callbacks,
				});
				record.result = result.text;
				this.settle(record, result.error);
			} catch (error) {
				this.settle(record, message(error));
			} finally {
				detach();
				if (!ranNew) this.finish(record, options.definition);
			}
		})();
		if (!options.background) await record.promise;
		return record;
	}

	restore(records: AgentRecord[]): void {
		this.records.clear();
		for (const record of records) this.records.set(record.id, record);
		this.changed();
	}

	get(id: string): AgentRecord | undefined {
		const exact = this.records.get(id);
		if (exact) return exact;
		const matches = [...this.records.values()].filter((record) => record.id.startsWith(id));
		return matches.length === 1 ? matches[0] : undefined;
	}

	list(): AgentRecord[] {
		return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	running(): AgentRecord[] {
		return [...this.records.values()]
			.filter((record) => record.status === "running")
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	async steer(id: string, text: string): Promise<boolean> {
		const record = this.get(id);
		if (record?.status !== "running") return false;
		if (!record.session) {
			record.pendingSteers.push(text);
			return true;
		}
		try {
			await record.session.steer(text);
			return true;
		} catch {
			return false;
		}
	}

	stop(id: string): boolean {
		const record = this.get(id);
		if (record?.status !== "running") return false;
		record.status = "stopped";
		record.completedAt = Date.now();
		record.abortController.abort();
		record.session?.abortCompaction();
		void record.session?.abort();
		this.changed();
		this.persisted(record);
		return true;
	}

	async shutdown(): Promise<void> {
		const records = [...this.records.values()];
		for (const record of records) {
			if (record.status !== "running") continue;
			record.status = "stopped";
			record.completedAt = Date.now();
			record.abortController.abort();
			record.session?.abortCompaction();
			void record.session?.abort();
			this.persisted(record);
		}
		await Promise.race([
			Promise.allSettled(records.map((record) => record.promise).filter(Boolean)),
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		for (const record of records) {
			record.session?.dispose();
			clearAgentContextCache(record.id);
		}
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.records.clear();
		this.changed();
	}

	private async run(
		record: AgentRecord,
		ctx: ExtensionContext,
		definition: AgentDefinition,
		prompt: string,
		options: SpawnOptions,
	): Promise<void> {
		const detach = onAbort(options.background ? undefined : options.signal, () => record.abortController.abort());
		try {
			if (record.abortController.signal.aborted) throw new Error("Subagent cancelled before setup.");
			if (definition.worktree && !record.worktree) record.worktree = await createWorktree(ctx.cwd, record.id);
			const result = await this.startSession(
				ctx,
				{
					id: record.id,
					definition,
					prompt,
					model: options.model,
					maxTurns: options.maxTurns,
					fork: options.fork,
					cwd: ctx.cwd,
					parentSignal: record.abortController.signal,
					worktree: record.worktree,
				},
				this.callbacks(record),
			);
			record.session = result.session;
			record.result = result.text;
			this.settle(record, result.error);
		} catch (error) {
			this.settle(record, message(error));
		} finally {
			detach();
			this.finish(record, definition);
		}
	}

	private settle(record: AgentRecord, error: string | undefined): void {
		if (record.status === "stopped") return;
		if (record.abortController.signal.aborted) {
			record.status = "stopped";
			return;
		}
		record.status = error ? "error" : "completed";
		record.error = error;
	}

	private callbacks(record: AgentRecord) {
		return {
			onSession: (session: AgentRecord["session"]) => {
				record.session = session;
				record.sessionFile = session?.sessionFile ?? record.sessionFile;
				if (session?.model) record.model = `${session.model.provider}/${session.model.id}`;
				record.thinking = session?.thinkingLevel ?? record.thinking;
				if (session) {
					for (const message of record.pendingSteers.splice(0)) void session.steer(message).catch(() => undefined);
				}
				this.changed();
				this.persisted(record);
			},
			onFallback: (model: Model<Api>, reason: string) => {
				record.model = `${model.provider}/${model.id}`;
				record.usedFallback = true;
				record.fallbackReason = reason;
				this.fallback(record, reason);
				this.changed();
				this.persisted(record);
			},
			onText: (text: string) => {
				record.result = text;
				this.scheduleRender();
			},
			onTurn: () => {
				record.turns += 1;
				this.changed();
			},
			onTool: () => {
				record.toolUses += 1;
				this.changed();
			},
			onReport: (summary: string) => this.reported(record, summary),
		};
	}

	private scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.changed();
		}, 80);
		this.renderTimer.unref?.();
	}

	private finish(record: AgentRecord, definition: AgentDefinition | undefined): void {
		record.completedAt ??= Date.now();
		if (record.worktree) {
			try {
				record.worktreeBranch = saveWorktree(record.worktree, record.prompt);
			} catch (error) {
				record.error = `${record.error ? `${record.error}; ` : ""}worktree: ${message(error)}`;
				if (record.status !== "stopped") record.status = "error";
			}
		}
		if ((definition?.outputTranscript ?? true) && record.session) {
			try {
				const outputFile = outputPath(record);
				mkdirSync(dirname(outputFile), { recursive: true });
				writeFileSync(outputFile, JSON.stringify(record.session.messages, null, 2), { mode: 0o600 });
			} catch {
				/* transcript output is best effort */
			}
		}
		this.changed();
		this.persisted(record);
		this.completed(record);
	}
}

function outputPath(record: AgentRecord): string {
	const sessionFile = record.session?.sessionFile;
	return sessionFile ? `${sessionFile}.output.json` : join(tmpdir(), "pi-subagents", `${record.id}.output.json`);
}
