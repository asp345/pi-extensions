import type { AgentRecord, AgentStatus, ThinkingLevel, WorktreeInfo } from "./types.ts";

export interface StoredAgentState {
	version: 1;
	id: string;
	type: string;
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
	model?: string;
	models: string[];
	usedFallback?: boolean;
	fallbackReason?: string;
	thinking?: ThinkingLevel;
	sessionFile?: string;
	worktree?: WorktreeInfo;
	worktreeBranch?: string;
	resultConsumed?: boolean;
}

export function storeRecord(record: AgentRecord): StoredAgentState {
	return {
		version: 1,
		id: record.id,
		type: record.type,
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
		model: record.model,
		models: record.models,
		usedFallback: record.usedFallback,
		fallbackReason: record.fallbackReason,
		thinking: record.thinking,
		sessionFile: record.session?.sessionFile ?? record.sessionFile,
		worktree: record.worktree,
		worktreeBranch: record.worktreeBranch,
		resultConsumed: record.resultConsumed,
	};
}

export function parseStoredRecord(value: unknown): StoredAgentState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.type !== "string" ||
		typeof value.title !== "string" ||
		typeof value.prompt !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.background !== "boolean" ||
		typeof value.startedAt !== "number" ||
		typeof value.turns !== "number" ||
		typeof value.toolUses !== "number" ||
		!isAgentStatus(value.status) ||
		!Array.isArray(value.models) ||
		!value.models.every((model) => typeof model === "string")
	) {
		return undefined;
	}
	const thinking = typeof value.thinking === "string" && isThinkingLevel(value.thinking) ? value.thinking : undefined;
	return {
		version: 1,
		id: value.id,
		type: value.type,
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
		model: stringValue(value.model),
		models: [...value.models],
		usedFallback: typeof value.usedFallback === "boolean" ? value.usedFallback : undefined,
		fallbackReason: stringValue(value.fallbackReason),
		thinking,
		sessionFile: stringValue(value.sessionFile),
		worktree: parseWorktree(value.worktree),
		worktreeBranch: stringValue(value.worktreeBranch),
		resultConsumed: typeof value.resultConsumed === "boolean" ? value.resultConsumed : undefined,
	};
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return value === "running" || value === "completed" || value === "stopped" || value === "error";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function parseWorktree(value: unknown): WorktreeInfo | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.root !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.branch !== "string" ||
		typeof value.base !== "string"
	) {
		return undefined;
	}
	return { root: value.root, cwd: value.cwd, branch: value.branch, base: value.base };
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
