import { randomUUID } from "node:crypto";
import type { CustomEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_STATE_ENTRY = "goal-state";
export const MAX_OBJECTIVE = 4_000;

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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
