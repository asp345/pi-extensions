import { createHash } from "node:crypto";
import { isRecord } from "@asp345/pi-shared/json.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_STATE_ENTRY, type GoalState } from "./state.ts";

const MAX_NO_PROGRESS_TURNS = 3;
const NUDGE_NO_PROGRESS_TURNS = 2;
const NUDGE_PROMPT =
	"You have made no progress across the last 2 automatic goal runs (no tool calls, repeated output). Do the possible work now: use tools to advance the /goal objective instead of repeating the previous message. If it is truly impossible to proceed, call goal_blocked. If the objective is complete, call goal_complete.";
const WORK_CHECK_IN_INTERVAL_MS = 15 * 60_000;
const GOAL_MESSAGE = "pi-goal";

interface GoalMessageDetails {
	kind: "start" | "continue";
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

type WorkSource = "background-tasks" | "subagents";

export interface GoalContext {
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
}

export class GoalRuntime {
	goal?: GoalState;
	private pendingContinuation?: string;
	private pendingStart?: string;
	private workCheckInDue = false;
	private workCheckInTimer?: ReturnType<typeof setTimeout>;
	private currentRunAutomatic = false;
	private currentRunUsedTool = false;
	private readonly runningWork = new Map<WorkSource, readonly string[]>();
	private settleFailure?: "aborted" | "error";

	constructor(private readonly pi: ExtensionAPI) {}

	persist() {
		this.pi.appendEntry(GOAL_STATE_ENTRY, { goal: this.goal ?? null });
	}

	setGoal(goal: GoalState | undefined, ctx: GoalContext) {
		this.clearWorkCheckIn();
		this.goal = goal;
		this.pendingContinuation = undefined;
		this.pendingStart = undefined;
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

	beforeAgentStart(message?: { customType: string; details?: unknown }) {
		this.currentRunAutomatic = false;
		this.currentRunUsedTool = false;
		if (message?.customType !== GOAL_MESSAGE) return;
		this.pendingContinuation = undefined;
		this.pendingStart = undefined;
		this.currentRunAutomatic = isRecord(message.details) && message.details.kind === "continue";
	}

	markToolCall() {
		this.currentRunUsedTool = true;
	}

	async setRunningWork(source: WorkSource, ids: readonly string[], ctx?: GoalContext) {
		const wasRunning = this.hasRunningWork();
		this.runningWork.set(source, ids);
		if (this.hasRunningWork()) this.scheduleWorkCheckIn(ctx);
		else this.clearWorkCheckIn();
		if (ctx && wasRunning && !this.hasRunningWork()) await this.settled(ctx);
	}

	finishAgent(messages: readonly unknown[]) {
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
				goal.nudgeSent = false;
			} else if (goal.nudgeSent) {
				goal.noProgressTurns = MAX_NO_PROGRESS_TURNS;
				goal.lastOutput = fingerprint;
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
		if (this.hasRunningWork()) this.scheduleWorkCheckIn(ctx);
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (this.workCheckInDue && this.hasRunningWork()) {
			this.workCheckInDue = false;
			await this.sendGoalMessage(
				"continue",
				"Check in on the active /goal and its running background tasks and subagents.",
			);
			return;
		}
		if (this.pendingContinuation !== goal.id || this.hasRunningWork()) return;
		const start = this.pendingStart === goal.id;
		if (!start && goal.noProgressTurns >= NUDGE_NO_PROGRESS_TURNS && !goal.nudgeSent) {
			goal.nudgeSent = true;
			goal.updatedAt = Date.now();
			this.persist();
			await this.sendGoalMessage("continue", NUDGE_PROMPT);
			return;
		}
		await this.sendGoalMessage(
			start ? "start" : "continue",
			start
				? "Work on the active /goal until it is complete."
				: "Continue the active /goal. Keep working until it is complete.",
		);
	}

	async settleAfterCompaction(ctx: GoalContext) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await this.settled(ctx);
	}

	pause(ctx: GoalContext, reason = "paused by user") {
		this.clearWorkCheckIn();
		if (this.goal?.status !== "active") return false;
		this.halt(ctx, "paused", reason);
		ctx.ui.notify(`Goal paused: ${reason}. Run /goal resume to continue.`, "warning");
		return true;
	}

	halt(ctx: GoalContext, status: "paused" | "blocked", reason: string) {
		const goal = this.goal;
		if (!goal) return;
		this.cancelContinuation();
		goal.status = status;
		goal.reason = reason;
		goal.updatedAt = Date.now();
		this.persist();
		this.updateStatus(ctx);
	}

	recordAutomaticTurn(message: unknown) {
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
			this.goal.nudgeSent = false;
			this.persist();
		}
	}

	shutdown() {
		this.clearWorkCheckIn();
		this.cancelContinuation();
	}

	private hasRunningWork() {
		return [...this.runningWork.values()].some((ids) => ids.length > 0);
	}

	private scheduleWorkCheckIn(ctx?: GoalContext) {
		if (this.workCheckInTimer || !ctx || this.goal?.status !== "active") return;
		this.workCheckInTimer = setTimeout(() => {
			this.workCheckInTimer = undefined;
			if (this.goal?.status !== "active" || !this.hasRunningWork()) return;
			this.workCheckInDue = true;
			this.scheduleWorkCheckIn(ctx);
			void this.settled(ctx);
		}, WORK_CHECK_IN_INTERVAL_MS);
		this.workCheckInTimer.unref?.();
	}

	private clearWorkCheckIn() {
		if (this.workCheckInTimer) clearTimeout(this.workCheckInTimer);
		this.workCheckInTimer = undefined;
		this.workCheckInDue = false;
	}

	private async sendGoalMessage(kind: "start" | "continue", text: string) {
		const goal = this.goal;
		if (goal?.status !== "active") return false;
		this.pi.sendMessage<GoalMessageDetails>(
			{
				customType: GOAL_MESSAGE,
				content: `${text}\n\nGoal ID: ${goal.id}\nObjective: ${goal.objective}`,
				display: true,
				details: { kind },
			},
			{ triggerTurn: true },
		);
		this.pendingContinuation = goal.id;
		return true;
	}
}
