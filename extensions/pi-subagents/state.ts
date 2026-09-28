import { type AgentRecord, isThinkingLevel, type StoredAgent } from "./types.ts";

export const STATE_KIND = "pi-subagent-state";

export function storeRecord(record: AgentRecord): StoredAgent {
	return {
		version: 2,
		id: record.id,
		name: record.name,
		prompt: record.prompt,
		cwd: record.cwd,
		model: record.model,
		thinking: record.thinking,
		sessionFile: record.sessionFile,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		cost: record.cost,
		lastText: record.lastText,
		lastError: record.lastError,
	};
}

export function parseStoredRecord(value: unknown): StoredAgent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = value as Record<string, unknown>;
	if (
		data.version !== 2 ||
		typeof data.id !== "string" ||
		typeof data.name !== "string" ||
		typeof data.prompt !== "string" ||
		typeof data.cwd !== "string" ||
		typeof data.createdAt !== "number" ||
		typeof data.updatedAt !== "number" ||
		typeof data.cost !== "number"
	) {
		return undefined;
	}
	return {
		version: 2,
		id: data.id,
		name: data.name,
		prompt: data.prompt,
		cwd: data.cwd,
		model: optionalString(data.model),
		thinking: isThinkingLevel(data.thinking) ? data.thinking : undefined,
		sessionFile: optionalString(data.sessionFile),
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		cost: data.cost,
		lastText: optionalString(data.lastText),
		lastError: optionalString(data.lastError),
	};
}

export function restoreRecord(stored: StoredAgent): AgentRecord {
	const { version: _version, ...fields } = stored;
	return { ...fields, running: false, repliesThisRun: 0, backgroundTasks: [] };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
