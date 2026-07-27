import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_STATE_ENTRY, type GoalState, serializeGoal } from "./state.js";

const MAX_AUTOMATIC_TURNS = 25;
const MAX_NO_PROGRESS_TURNS = 3;
const MAX_OWNED_PROMPTS = 16;
const OWNED_PROMPT_TTL_MS = 10 * 60_000;
const MARKER = /<!-- pi-goal:(start|continue):([^\s>]+) -->/u;

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
		this.pi.appendEntry(GOAL_STATE_ENTRY, serializeGoal(this.goal));
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
		if (!this.goal) return false;
		return this.sendOwnedPrompt(ctx, "start", "Work on the active /goal until it is complete.");
	}

	async resumeRestored(ctx: GoalContext) {
		if (!this.goal || this.goal.status !== "active") return;
		this.pendingContinuation = this.goal.id;
		await this.settled(ctx);
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

	manualInput(resetSafety = true) {
		this.currentRunAutomatic = false;
		this.cancelContinuation(resetSafety);
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
		this.pendingContinuation = this.goal.id;
		await this.settled(ctx);
	}

	private recordOwnedPrompt(marker: string) {
		const now = Date.now();
		for (const [key, stamp] of this.ownedPrompts) {
			if (now - stamp > OWNED_PROMPT_TTL_MS) this.ownedPrompts.delete(key);
		}
		while (this.ownedPrompts.size >= MAX_OWNED_PROMPTS) {
			const oldest = this.ownedPrompts.keys().next().value;
			if (oldest === undefined) break;
			this.ownedPrompts.delete(oldest);
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

function finalAssistant(messages: readonly unknown[]) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isRecord(message) && message.role === "assistant") {
			return message as { stopReason?: "aborted" | "error" | string };
		}
	}
	return undefined;
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
