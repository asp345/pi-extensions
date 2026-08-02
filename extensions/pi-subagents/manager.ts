import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModels, resolveThinking, resumeSession, runNew } from "./runner.js";
import type { AgentDefinition, AgentRecord, ThinkingLevel } from "./types.js";
import { message, onAbort } from "./util.js";
import { createWorktree, removeWorktree, saveWorktree } from "./worktree.js";

interface SpawnOptions {
	background: boolean;
	model?: string;
	maxTurns?: number;
	fork: boolean;
	signal?: AbortSignal;
}

interface ResumeOptions {
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
		private readonly startSession: typeof runNew = runNew,
	) {}

	spawn(ctx: ExtensionContext, definition: AgentDefinition, prompt: string, options: SpawnOptions): AgentRecord {
		const id = randomUUID();
		const record: AgentRecord = {
			id,
			type: definition.name,
			prompt,
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
		record.promise = this.run(record, ctx, definition, prompt, options);
		return record;
	}

	async resume(ctx: ExtensionContext, id: string, prompt: string, options: ResumeOptions): Promise<AgentRecord> {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown subagent ID: ${id}`);
		if (record.status === "running") throw new Error(`Subagent ${id} is already running.`);
		const previousRun = record.promise;
		if (previousRun) await previousRun;
		if (record.promise !== previousRun) {
			throw new Error(`Subagent ${id} is already running.`);
		}
		if (!record.session) throw new Error(`Subagent ${id} has no resumable session.`);
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
		const callbacks = this.callbacks(record);
		record.promise = (async () => {
			const detach = onAbort(options.background ? undefined : options.signal, () => record.abortController.abort());
			try {
				const result = await resumeSession(record.session!, prompt, {
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
				this.finish(record, undefined);
			}
		})();
		if (!options.background) await record.promise;
		return record;
	}

	get(id: string): AgentRecord | undefined {
		return this.records.get(id);
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
		const record = this.records.get(id);
		if (!record || record.status !== "running") return false;
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

	cancel(id: string): boolean {
		const record = this.records.get(id);
		if (!record || record.status !== "running") return false;
		record.status = "cancelled";
		record.completedAt = Date.now();
		record.abortController.abort();
		void record.session?.abort();
		this.changed();
		return true;
	}

	clearFinished(parentCwd: string): number {
		let count = 0;
		for (const [id, record] of this.records) {
			if (record.status === "running") continue;
			this.cleanup(record, parentCwd);
			this.records.delete(id);
			count += 1;
		}
		this.changed();
		return count;
	}

	async shutdown(parentCwd: string): Promise<void> {
		const records = [...this.records.values()];
		for (const record of records) {
			if (record.status !== "running") continue;
			record.status = "cancelled";
			record.abortController.abort();
			void record.session?.abort();
		}
		await Promise.race([
			Promise.allSettled(records.map((record) => record.promise).filter(Boolean)),
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		for (const record of records) this.cleanup(record, parentCwd);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.records.clear();
		this.changed();
	}

	private cleanup(record: AgentRecord, parentCwd: string): void {
		record.session?.dispose();
		if (record.worktree) removeWorktree(parentCwd, record.worktree);
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
			if (definition.worktree) record.worktree = await createWorktree(ctx.cwd, record.id);
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
		if (record.status === "cancelled") return;
		if (record.abortController.signal.aborted) {
			record.status = "cancelled";
			return;
		}
		record.status = error ? "error" : "completed";
		record.error = error;
	}

	private callbacks(record: AgentRecord) {
		return {
			onSession: (session: AgentRecord["session"]) => {
				record.session = session;
				if (session?.model) record.model = `${session.model.provider}/${session.model.id}`;
				record.thinking = session?.thinkingLevel ?? record.thinking;
				if (session) {
					for (const message of record.pendingSteers.splice(0)) void session.steer(message).catch(() => undefined);
				}
				this.changed();
			},
			onFallback: (model: Model<Api>, reason: string) => {
				record.model = `${model.provider}/${model.id}`;
				record.usedFallback = true;
				record.fallbackReason = reason;
				this.fallback(record, reason);
				this.changed();
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
				if (record.status !== "cancelled") record.status = "error";
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
		this.completed(record);
	}
}

function outputPath(record: AgentRecord): string {
	const sessionFile = record.session?.sessionFile;
	return sessionFile ? `${sessionFile}.output.json` : join(tmpdir(), "pi-subagents", `${record.id}.output.json`);
}
