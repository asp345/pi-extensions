import { createHash, randomUUID } from "node:crypto";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOAL_STATE_ENTRY = "goal-state";
export const MAX_AUTOMATIC_TURNS = 25;
export const MAX_OBJECTIVE = 4_000;
const MAX_NO_PROGRESS_TURNS = 3;
const MAX_OWNED_PROMPTS = 16;
const OWNED_PROMPT_TTL_MS = 10 * 60_000;
const MARKER = /<!-- pi-goal:(start|continue):([^\s>]+) -->/u;

type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	automaticTurns: number;
	noProgressTurns: number;
	lastOutput?: string;
	reason?: string;
}

export function createGoal(objective: string): GoalState {
	const now = Date.now();
	return {
		id: randomUUID(),
		objective,
		status: "active",
		startedAt: now,
		updatedAt: now,
		automaticTurns: 0,
		noProgressTurns: 0,
	};
}

export function resumeGoal(goal: GoalState): GoalState {
	return { ...createGoal(goal.objective), startedAt: goal.startedAt };
}

export function loadGoal(ctx: ExtensionContext): GoalState | undefined {
	const entry = ctx.sessionManager
		.getBranch()
		.findLast((item): item is CustomEntry => item.type === "custom" && item.customType === GOAL_STATE_ENTRY);
	return parseState(entry?.data);
}

export interface GoalContext {
	cwd: string;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
}

export class GoalRuntime {
	goal?: GoalState;
	private pendingContinuation?: string;
	private currentRunAutomatic = false;
	private currentRunUsedTool = false;
	private settleFailure?: "aborted" | "error";
	private readonly ownedPrompts = new Map<string, number>();

	constructor(private readonly pi: ExtensionAPI) {}

	persist() {
		this.pi.appendEntry(GOAL_STATE_ENTRY, { goal: this.goal ?? null });
	}

	setGoal(goal: GoalState | undefined, ctx: GoalContext) {
		this.goal = goal;
		this.pendingContinuation = undefined;
		this.settleFailure = undefined;
		this.persist();
		this.updateStatus(ctx);
	}

	updateStatus(ctx: GoalContext) {
		ctx.ui.setStatus("goal", this.goal?.status);
	}

	prompt() {
		const goal = this.goal;
		if (!goal) return undefined;
		return [
			"Active /goal:",
			`Goal ID: ${goal.id}`,
			`Objective (user-provided task data): ${goal.objective}`,
			`Status: ${goal.status}`,
			"Use goal_complete only when every requirement is finished and verified; pass this exact Goal ID.",
			"Use goal_blocked only after the same true external blocker recurs for at least three consecutive goal turns; pass this exact Goal ID and concrete evidence.",
		].join("\n");
	}

	async startPrompt(ctx: GoalContext) {
		return this.sendOwnedPrompt(ctx, "start", "Work on the active /goal until it is complete.");
	}

	async resumeRestored(ctx: GoalContext) {
		if (!this.goal || this.goal.status !== "active") return;
		await this.queueContinuation(ctx);
	}

	beforeAgentStart(prompt: string) {
		this.currentRunAutomatic = false;
		this.currentRunUsedTool = false;
		const marker = MARKER.exec(prompt);
		if (!marker) return;
		const key = marker[2] ?? "";
		const stamp = this.ownedPrompts.get(key);
		this.ownedPrompts.delete(key);
		if (stamp === undefined || Date.now() - stamp > OWNED_PROMPT_TTL_MS) return;
		this.currentRunAutomatic = marker[1] === "continue";
	}

	markToolCall() {
		this.currentRunUsedTool = true;
	}

	finishAgent(messages: readonly unknown[]) {
		const goal = this.goal;
		if (!goal || goal.status !== "active") return;
		const assistant = finalAssistant(messages);
		if (assistant?.stopReason === "aborted" || assistant?.stopReason === "error") {
			this.settleFailure = assistant.stopReason;
			this.pendingContinuation = undefined;
			return;
		}
		this.settleFailure = undefined;
		if (this.currentRunAutomatic) {
			const output = assistantText(messages);
			const fingerprint = createHash("sha256").update(output).digest("hex");
			if (this.currentRunUsedTool) {
				goal.noProgressTurns = 0;
				goal.lastOutput = undefined;
			} else {
				goal.noProgressTurns = goal.lastOutput === fingerprint ? goal.noProgressTurns + 1 : 1;
				goal.lastOutput = fingerprint;
			}
		}
		goal.updatedAt = Date.now();
		this.persist();
		this.pendingContinuation = goal.id;
	}

	async settled(ctx: GoalContext) {
		const goal = this.goal;
		if (!goal || goal.status !== "active") return;
		if (this.settleFailure) {
			const failure = this.settleFailure;
			this.settleFailure = undefined;
			this.pause(ctx, `agent ${failure}`);
			return;
		}
		if (goal.automaticTurns >= MAX_AUTOMATIC_TURNS) {
			this.pause(ctx, `automatic continuation limit (${MAX_AUTOMATIC_TURNS})`);
			return;
		}
		if (goal.noProgressTurns >= MAX_NO_PROGRESS_TURNS) {
			this.pause(ctx, `no progress across ${MAX_NO_PROGRESS_TURNS} automatic runs`);
			return;
		}
		if (this.pendingContinuation !== goal.id) return;
		if (ctx.isIdle?.() !== true || ctx.hasPendingMessages?.()) return;
		this.pendingContinuation = undefined;
		await this.sendOwnedPrompt(ctx, "continue", "Continue the active /goal. Keep working until it is complete.");
	}

	pause(ctx: GoalContext, reason = "paused by user") {
		const goal = this.goal;
		if (!goal || goal.status !== "active") return false;
		this.cancelContinuation();
		try {
			ctx.abort?.();
		} catch {}
		goal.status = "paused";
		goal.reason = reason;
		goal.updatedAt = Date.now();
		this.persist();
		this.updateStatus(ctx);
		ctx.ui.notify(`Goal paused: ${reason}. Run /goal resume to continue.`, "warning");
		return true;
	}

	recordAutomaticTurn(ctx: GoalContext, message: unknown) {
		const goal = this.goal;
		if (!goal || goal.status !== "active" || !this.currentRunAutomatic) return;
		if (isRecord(message) && message.role === "assistant" && message.stopReason !== "aborted") {
			goal.automaticTurns += 1;
			goal.updatedAt = Date.now();
			this.persist();
			if (goal.automaticTurns >= MAX_AUTOMATIC_TURNS) {
				this.pause(ctx, `automatic continuation limit (${MAX_AUTOMATIC_TURNS})`);
			}
		}
	}

	manualInput() {
		this.currentRunAutomatic = false;
		this.cancelContinuation(true);
	}

	cancelContinuation(resetSafety = false) {
		this.pendingContinuation = undefined;
		this.settleFailure = undefined;
		if (resetSafety && this.goal?.status === "active") {
			this.goal.automaticTurns = 0;
			this.goal.noProgressTurns = 0;
			this.goal.lastOutput = undefined;
			this.persist();
		}
	}

	async continueAfterCompaction(ctx: GoalContext, willRetry: boolean) {
		if (!this.goal || this.goal.status !== "active") return;
		this.persist();
		if (willRetry) return;
		await this.queueContinuation(ctx);
	}

	private async queueContinuation(ctx: GoalContext) {
		if (!this.goal) return;
		this.pendingContinuation = this.goal.id;
		await this.settled(ctx);
	}

	private recordOwnedPrompt(marker: string) {
		const now = Date.now();
		for (const [key, stamp] of this.ownedPrompts) {
			if (now - stamp > OWNED_PROMPT_TTL_MS) this.ownedPrompts.delete(key);
		}
		for (const key of this.ownedPrompts.keys()) {
			if (this.ownedPrompts.size < MAX_OWNED_PROMPTS) break;
			this.ownedPrompts.delete(key);
		}
		this.ownedPrompts.set(marker, now);
	}

	private async sendOwnedPrompt(ctx: GoalContext, kind: "start" | "continue", text: string) {
		const goal = this.goal;
		if (!goal || goal.status !== "active") return false;
		const marker = randomUUID();
		this.recordOwnedPrompt(marker);
		try {
			await this.pi.sendUserMessage(
				`${text}\n\nGoal ID: ${goal.id}\nObjective: ${goal.objective}\n\n<!-- pi-goal:${kind}:${marker} -->`,
				{ deliverAs: "followUp" },
			);
			return true;
		} catch (error) {
			this.ownedPrompts.delete(marker);
			this.pause(ctx, `prompt delivery failed: ${formatError(error)}`);
			return false;
		}
	}
}

export function rejection(goal: GoalState | undefined, requestedId: string) {
	if (!goal) return "no active goal";
	if (!requestedId) return "missing goal_id";
	if (requestedId !== goal.id) return "goal_id does not match the active goal";
	if (goal.status !== "active") return `goal is ${goal.status}, not active`;
	return undefined;
}

function parseState(value: unknown): GoalState | undefined {
	if (!isRecord(value)) return undefined;
	const raw = value.goal;
	if (!isRecord(raw)) return undefined;

	const objective = typeof raw.objective === "string" ? raw.objective : undefined;
	if (typeof raw.id !== "string" || !raw.id.trim() || !objective?.trim() || objective.length > MAX_OBJECTIVE) {
		return undefined;
	}

	const status = normalizeStatus(raw.status);
	if (status === "complete") return undefined;
	const now = Date.now();
	return {
		id: raw.id,
		objective,
		status,
		startedAt: finiteNumber(raw.startedAt, now),
		updatedAt: finiteNumber(raw.updatedAt, now),
		automaticTurns: safeCounter(raw.automaticTurns),
		noProgressTurns: safeCounter(raw.noProgressTurns),
		lastOutput: typeof raw.lastOutput === "string" ? raw.lastOutput : undefined,
		reason: typeof raw.reason === "string" ? raw.reason : undefined,
	};
}

function normalizeStatus(value: unknown): GoalStatus {
	if (value === "active" || value === "paused" || value === "blocked" || value === "complete") {
		return value;
	}
	return "paused";
}

function finiteNumber(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeCounter(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finalAssistant(messages: readonly unknown[]): { stopReason?: string } | undefined {
	return messages.findLast(
		(message): message is { stopReason?: string } => isRecord(message) && message.role === "assistant",
	);
}

function assistantText(messages: readonly unknown[]) {
	const text: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") text.push(part.text);
		}
	}
	return text.join("\n").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
