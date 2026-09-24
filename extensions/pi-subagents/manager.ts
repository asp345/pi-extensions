import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recoveryPrompt } from "./delegation.ts";
import { bounded } from "./format.ts";
import { resolveThinking } from "./models.ts";
import type { RpcMessage, RpcProcess } from "./rpc.ts";
import { type RpcCallbacks, type RunResult, resumeProc, runNew } from "./runner.ts";
import { compactTranscript } from "./transcript.ts";
import type { AgentRecord, ThinkingLevel } from "./types.ts";
import { message, onAbort } from "./util.ts";

interface SpawnOptions {
	background: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	signal?: AbortSignal;
}

interface ResumeOptions extends SpawnOptions {
	title: string;
}

const CONTINUATION = "Continue the assigned task from where it stopped.";

export class AgentManager {
	private readonly records = new Map<string, AgentRecord>();
	private renderTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly changed: () => void,
		private readonly completed: (record: AgentRecord) => void,
		private readonly resumed: (record: AgentRecord) => void,
		private readonly reported: (record: AgentRecord, summary: string) => void,
		private readonly persisted: (record: AgentRecord) => void,
		private readonly startSession: typeof runNew = runNew,
	) {}

	spawn(ctx: ExtensionContext, title: string, prompt: string, options: SpawnOptions): AgentRecord {
		const id = randomUUID();
		const record: AgentRecord = {
			id,
			title,
			prompt,
			cwd: ctx.cwd,
			status: "running",
			background: options.background,
			startedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			model: options.model,
			thinking: resolveThinking(options.thinking, ctx),
			messages: [],
			abortController: new AbortController(),
			pendingSteers: [],
		};
		this.records.set(id, record);
		this.changed();
		this.persisted(record);
		record.promise = this.run(record, ctx, prompt, options);
		return record;
	}

	async resume(ctx: ExtensionContext, id: string, options: ResumeOptions): Promise<AgentRecord> {
		const record = this.get(id);
		if (!record) throw new Error(`Unknown or ambiguous subagent ID: ${id}`);
		if (record.status === "running") throw new Error(`Subagent ${id} is already running.`);
		const previousRun = record.promise;
		if (previousRun) await previousRun;
		if (record.promise !== previousRun) {
			throw new Error(`Subagent ${id} is already running.`);
		}
		const damaged = record.damagedSession === true;
		if (damaged && record.proc && !record.proc.closed) {
			void record.proc.stop().catch(() => undefined);
		}
		const live = !damaged && record.proc && !record.proc.closed ? record.proc : undefined;
		const restartFresh = !live && (!record.sessionFile || damaged);
		let prompt: string;
		if (damaged) {
			prompt = recoveryPrompt(record.prompt, recoveryContext(record));
		} else if (restartFresh) {
			prompt = record.prompt;
		} else {
			prompt = CONTINUATION;
		}
		record.title = options.title;
		record.background = options.background;
		record.status = "running";
		record.error = undefined;
		record.result = undefined;
		record.completedAt = undefined;
		record.abortController = new AbortController();
		if (options.model) record.model = options.model;
		record.thinking = options.thinking ?? record.thinking;
		record.resultConsumed = false;
		this.resumed(record);
		this.changed();
		this.persisted(record);
		if (restartFresh) {
			record.promise = this.run(record, ctx, prompt, options);
			if (!options.background) await record.promise;
			return record;
		}
		const callbacks = this.callbacks(record);
		record.promise = (async () => {
			const detach = onAbort(options.background ? undefined : options.signal, () => record.abortController.abort());
			try {
				const result = await resumeProc(
					live,
					ctx,
					{
						id: record.id,
						title: record.title,
						cwd: record.cwd,
						sessionFile: record.sessionFile,
						prompt,
						model: options.model,
						thinking: options.thinking ?? record.thinking,
						signal: record.abortController.signal,
					},
					callbacks,
				);
				this.applyResult(record, result);
				this.settle(record, result.error);
			} catch (error) {
				this.settle(record, message(error));
			} finally {
				detach();
				this.finish(record);
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
		const needle = id.trim();
		if (!needle) return undefined;
		const exact = this.records.get(needle) ?? this.records.get(id);
		if (exact) return exact;
		const lower = needle.toLowerCase();
		const exactCaseInsensitive = [...this.records.values()].find((record) => record.id.toLowerCase() === lower);
		if (exactCaseInsensitive) return exactCaseInsensitive;
		const matches = [...this.records.values()].filter(
			(record) => record.id.startsWith(needle) || record.id.toLowerCase().startsWith(lower),
		);
		return matches.length === 1 ? matches[0] : undefined;
	}

	matches(id: string): AgentRecord[] {
		const needle = id.trim().toLowerCase();
		if (!needle) return [];
		return [...this.records.values()].filter((record) => record.id.toLowerCase().startsWith(needle));
	}

	describeIds(): string {
		const records = this.list();
		if (!records.length) return "none";
		return records.map((record) => `${record.id} (${record.title}, ${record.status})`).join(", ");
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
		if (!record.proc || record.proc.closed) {
			record.pendingSteers.push(text);
			return true;
		}
		try {
			await record.proc.steer(text);
			return true;
		} catch {
			return false;
		}
	}

	stop(id: string, markConsumed = true): boolean {
		const record = this.get(id);
		if (record?.status !== "running") return false;
		record.status = "stopped";
		record.completedAt = Date.now();
		record.abortController.abort();
		// Tool-initiated stops are acknowledged by the tool result itself, so the
		// background completion notification must not fire. User-initiated stops
		// (dashboard, /agents) pass markConsumed=false so the parent still learns
		// about the stop through the normal completion steering.
		if (markConsumed) record.resultConsumed = true;
		void record.proc?.abort().catch(() => undefined);
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
			void record.proc?.abort().catch(() => undefined);
			this.persisted(record);
		}
		await Promise.race([
			Promise.allSettled(records.map((record) => record.promise).filter(Boolean)),
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		await Promise.allSettled(records.map((record) => record.proc?.stop().catch(() => undefined)));
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.records.clear();
		this.changed();
	}

	private async run(record: AgentRecord, ctx: ExtensionContext, prompt: string, options: SpawnOptions): Promise<void> {
		const detach = onAbort(options.background ? undefined : options.signal, () => record.abortController.abort());
		try {
			if (record.abortController.signal.aborted) throw new Error("Subagent cancelled before setup.");
			const result = await this.startSession(
				ctx,
				{
					id: record.id,
					title: record.title,
					prompt,
					model: options.model,
					thinking: options.thinking,
					cwd: record.cwd,
					parentSignal: record.abortController.signal,
				},
				this.callbacks(record),
			);
			this.applyResult(record, result);
			this.settle(record, result.error);
		} catch (error) {
			this.settle(record, message(error));
		} finally {
			detach();
			this.finish(record);
		}
	}

	private applyResult(record: AgentRecord, result: RunResult): void {
		record.proc = result.proc;
		record.messages = result.messages;
		record.damagedSession = result.damagedSession ? true : undefined;
		if (result.sessionFile) record.sessionFile = result.sessionFile;
		if (result.model) record.model = result.model;
		record.result = result.text;
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

	private callbacks(record: AgentRecord): RpcCallbacks {
		return {
			onSession: (proc: RpcProcess, info) => {
				record.proc = proc;
				if (info.sessionFile) record.sessionFile = info.sessionFile;
				if (info.model) record.model = info.model;
				if (info.thinking) record.thinking = info.thinking;
				if (record.pendingSteers.length) {
					for (const pending of record.pendingSteers.splice(0)) {
						void proc.steer(pending).catch(() => undefined);
					}
				}
				this.changed();
				this.persisted(record);
			},
			onMessages: (messages: RpcMessage[]) => {
				record.messages = messages;
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

	private finish(record: AgentRecord): void {
		record.completedAt ??= Date.now();
		if (record.messages.length) {
			try {
				const outputFile = outputPath(record);
				mkdirSync(dirname(outputFile), { recursive: true });
				writeFileSync(outputFile, JSON.stringify(record.messages, null, 2), { mode: 0o600 });
			} catch {
				/* transcript output is best effort */
			}
		}
		this.changed();
		this.persisted(record);
		this.completed(record);
	}
}

function recoveryContext(record: AgentRecord): string {
	return bounded(compactTranscript(record.messages), 4_000, 60).text;
}

function outputPath(record: AgentRecord): string {
	return record.sessionFile
		? `${record.sessionFile}.output.json`
		: join(tmpdir(), "pi-subagents", `${record.id}.output.json`);
}
