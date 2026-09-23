import type { AgentRecord, AgentStatus, ThinkingLevel } from "./types.ts";

export interface StoredAgentState {
	version: 1;
	id: string;
	title: string;
	prompt: string;
	cwd: string;
	status: AgentStatus;
	background: boolean;
	startedAt: number;
	completedAt?: number;
	turns: number;
	toolUses: number;
	result?: string;
	error?: string;
	damagedSession?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	sessionFile?: string;
	resultConsumed?: boolean;
}

export function storeRecord(record: AgentRecord): StoredAgentState {
	return {
		version: 1,
		id: record.id,
		title: record.title,
		prompt: record.prompt,
		cwd: record.cwd,
		status: record.status,
		background: record.background,
		startedAt: record.startedAt,
		completedAt: record.completedAt,
		turns: record.turns,
		toolUses: record.toolUses,
		result: record.result,
		error: record.error,
		damagedSession: record.damagedSession ? true : undefined,
		model: record.model,
		thinking: record.thinking,
		sessionFile: record.sessionFile,
		resultConsumed: record.resultConsumed,
	};
}

export function parseStoredRecord(value: unknown): StoredAgentState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.title !== "string" ||
		typeof value.prompt !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.background !== "boolean" ||
		typeof value.startedAt !== "number" ||
		typeof value.turns !== "number" ||
		typeof value.toolUses !== "number" ||
		!isAgentStatus(value.status)
	) {
		return undefined;
	}
	const thinking = typeof value.thinking === "string" && isThinkingLevel(value.thinking) ? value.thinking : undefined;
	return {
		version: 1,
		id: value.id,
		title: value.title,
		prompt: value.prompt,
		cwd: value.cwd,
		status: value.status,
		background: value.background,
		startedAt: value.startedAt,
		completedAt: numberValue(value.completedAt),
		turns: value.turns,
		toolUses: value.toolUses,
		result: stringValue(value.result),
		error: stringValue(value.error),
		damagedSession: value.damagedSession === true ? true : undefined,
		model: stringValue(value.model),
		thinking,
		sessionFile: stringValue(value.sessionFile),
		resultConsumed: typeof value.resultConsumed === "boolean" ? value.resultConsumed : undefined,
	};
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return value === "running" || value === "completed" || value === "stopped" || value === "error";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
