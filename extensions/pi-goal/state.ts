import { randomUUID } from "node:crypto";

export const GOAL_STATE_ENTRY = "goal-state";
export type GoalStatus = "active" | "paused" | "blocked" | "complete";

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

interface SessionContext {
	sessionManager?: {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
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
	return {
		...goal,
		id: randomUUID(),
		status: "active",
		updatedAt: Date.now(),
		automaticTurns: 0,
		noProgressTurns: 0,
		lastOutput: undefined,
		reason: undefined,
	};
}

export function loadGoal(ctx: SessionContext): GoalState | undefined {
	const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
		return parseState(entry.data);
	}
	return undefined;
}

export function serializeGoal(goal: GoalState | undefined) {
	return { goal: goal ?? null };
}

function parseState(value: unknown): GoalState | undefined {
	if (!isRecord(value)) return undefined;
	const raw = value.goal;
	if (raw === null) return undefined;
	if (!isRecord(raw)) return undefined;

	const objective =
		typeof raw.objective === "string" ? raw.objective : typeof raw.text === "string" ? raw.text : undefined;
	if (typeof raw.id !== "string" || !raw.id.trim() || !objective?.trim() || objective.length > 4_000) {
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
		automaticTurns: safeCounter(raw.automaticTurns ?? raw.automaticModelTurns),
		noProgressTurns: safeCounter(raw.noProgressTurns ?? raw.toolFreeRepeatCount),
		lastOutput:
			typeof raw.lastOutput === "string"
				? raw.lastOutput
				: typeof raw.lastToolFreeOutputFingerprint === "string"
					? raw.lastToolFreeOutputFingerprint
					: undefined,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
