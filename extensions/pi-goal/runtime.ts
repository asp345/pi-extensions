import { createHash, randomUUID } from "node:crypto";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOAL_STATE_ENTRY = "goal-state";
export const MAX_OBJECTIVE = 4_000;
const MAX_NO_PROGRESS_TURNS = 3;
const MAX_OWNED_PROMPTS = 16;
const OWNED_PROMPT_TTL_MS = 10 * 60_000;
const BACKGROUND_CHECK_IN_INTERVAL_MS = 60 * 60_000;
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
	private pendingStart?: string;
	private backgroundCheckInDue = false;
	private backgroundCheckInTimer?: ReturnType<typeof setTimeout>;
	private currentRunAutomatic = false;
	private currentRunOwnsGoal = false;
	private currentRunUsedTool = false;
	private readonly runningBackgroundTaskIds = new Set<string>();
	private readonly goalBackgroundTaskIds = new Set<string>();
	private settleFailure?: "aborted" | "error";
	private readonly ownedPrompts = new Map<string, number>();

	constructor(private readonly pi: ExtensionAPI) {}

	persist() {
		this.pi.appendEntry(GOAL_STATE_ENTRY, { goal: this.goal ?? null });
	}

	setGoal(goal: GoalState | undefined, ctx: GoalContext) {
		this.clearBackgroundCheckIn();
		this.goal = goal;
		this.pendingContinuation = undefined;
		this.pendingStart = undefined;
		this.currentRunOwnsGoal = false;
		this.goalBackgroundTaskIds.clear();
		this.settleFailure = undefined;
		this.persist();
		this.updateStatus(ctx);
	}

	updateStatus(ctx: GoalContext) {
		ctx.ui.setStatus("goal", this.goal?.status);
	}

	async startPrompt(ctx: GoalContext) {
		const goal = this.goal;
		if (goal?.status !== "active") return false;
		this.pendingContinuation = goal.id;
		this.pendingStart = goal.id;
		await this.settled(ctx);
		return true;
	}

	async resumeRestored(ctx: GoalContext) {
		if (this.goal?.status !== "active") return;
		this.pendingContinuation = this.goal.id;
		await this.settled(ctx);
	}

	beforeAgentStart(prompt: string) {
		this.currentRunAutomatic = false;
		this.currentRunOwnsGoal = false;
		this.currentRunUsedTool = false;
		const marker = MARKER.exec(prompt);
		if (!marker) return;
		const key = marker[2] ?? "";
		const stamp = this.ownedPrompts.get(key);
		this.ownedPrompts.delete(key);
		if (stamp === undefined || Date.now() - stamp > OWNED_PROMPT_TTL_MS) return;
		this.pendingContinuation = undefined;
		this.pendingStart = undefined;
		this.currentRunOwnsGoal = true;
		this.currentRunAutomatic = marker[1] === "continue";
	}

	markToolCall() {
		this.currentRunUsedTool = true;
	}

	async setRunningBackgroundTasks(taskIds: readonly string[], ctx?: GoalContext) {
		const next = new Set(taskIds);
		if (this.goal?.status === "active" && (this.currentRunOwnsGoal || this.pendingContinuation === this.goal.id)) {
			for (const id of next) {
				if (!this.runningBackgroundTaskIds.has(id)) this.goalBackgroundTaskIds.add(id);
			}
		}
		const wasWaiting = this.goalBackgroundTaskIds.size > 0;
		for (const id of this.goalBackgroundTaskIds) {
			if (!next.has(id)) this.goalBackgroundTaskIds.delete(id);
		}
		this.runningBackgroundTaskIds.clear();
		for (const id of next) this.runningBackgroundTaskIds.add(id);
		if (this.goalBackgroundTaskIds.size > 0) this.scheduleBackgroundCheckIn(ctx);
		else this.clearBackgroundCheckIn();
		if (wasWaiting && this.goalBackgroundTaskIds.size === 0 && ctx) await this.settled(ctx);
	}

	finishAgent(messages: readonly unknown[]) {
		this.currentRunOwnsGoal = false;
		const goal = this.goal;
		if (goal?.status !== "active") return;
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
		if (goal?.status !== "active") return;
		if (this.settleFailure) {
			const failure = this.settleFailure;
			this.settleFailure = undefined;
			this.pause(ctx, `agent ${failure}`);
			return;
		}
		if (goal.noProgressTurns >= MAX_NO_PROGRESS_TURNS) {
			this.pause(ctx, `no progress across ${MAX_NO_PROGRESS_TURNS} automatic runs`);
			return;
		}
		if (ctx.isIdle?.() !== true || ctx.hasPendingMessages?.()) return;
		if (this.backgroundCheckInDue && this.goalBackgroundTaskIds.size > 0) {
			this.backgroundCheckInDue = false;
			await this.sendOwnedPrompt("continue", "Check in on the active /goal and its running background work.");
			return;
		}
		if (this.pendingContinuation !== goal.id || this.goalBackgroundTaskIds.size > 0) return;
		const start = this.pendingStart === goal.id;
		await this.sendOwnedPrompt(
			start ? "start" : "continue",
			start
				? "Work on the active /goal until it is complete."
				: "Continue the active /goal. Keep working until it is complete.",
		);
	}

	clearGoal(ctx: GoalContext) {
		const abortOwnedRun = this.currentRunOwnsGoal;
		this.setGoal(undefined, ctx);
		if (abortOwnedRun) {
			try {
				ctx.abort?.();
			} catch {}
		}
	}

	pause(ctx: GoalContext, reason = "paused by user") {
		const goal = this.goal;
		this.clearBackgroundCheckIn();
		if (goal?.status !== "active") return false;
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

	recordAutomaticTurn(_ctx: GoalContext, message: unknown) {
		const goal = this.goal;
		if (goal?.status !== "active" || !this.currentRunAutomatic) return;
		if (isRecord(message) && message.role === "assistant" && message.stopReason !== "aborted") {
			goal.automaticTurns += 1;
			goal.updatedAt = Date.now();
			this.persist();
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

	shutdown() {
		this.clearBackgroundCheckIn();
		this.cancelContinuation();
	}

	private scheduleBackgroundCheckIn(ctx?: GoalContext) {
		if (this.backgroundCheckInTimer || !ctx || this.goal?.status !== "active") return;
		this.backgroundCheckInTimer = setTimeout(() => {
			this.backgroundCheckInTimer = undefined;
			if (this.goal?.status !== "active" || this.goalBackgroundTaskIds.size === 0) return;
			this.backgroundCheckInDue = true;
			this.scheduleBackgroundCheckIn(ctx);
			void this.settled(ctx);
		}, BACKGROUND_CHECK_IN_INTERVAL_MS);
		this.backgroundCheckInTimer.unref?.();
	}

	private clearBackgroundCheckIn() {
		if (this.backgroundCheckInTimer) clearTimeout(this.backgroundCheckInTimer);
		this.backgroundCheckInTimer = undefined;
		this.backgroundCheckInDue = false;
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

	private async sendOwnedPrompt(kind: "start" | "continue", text: string) {
		const goal = this.goal;
		if (goal?.status !== "active") return false;
		const marker = randomUUID();
		this.recordOwnedPrompt(marker);
		this.pi.sendUserMessage(
			`${text}\n\nGoal ID: ${goal.id}\nObjective: ${goal.objective}\n\n<!-- pi-goal:${kind}:${marker} -->`,
		);
		this.pendingContinuation = goal.id;
		return true;
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
