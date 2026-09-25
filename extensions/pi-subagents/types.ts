import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentStatus = "running" | "idle" | "inactive";

export interface StoredAgent {
	version: 2;
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	sessionFile?: string;
	createdAt: number;
	updatedAt: number;
	cost: number;
	lastText?: string;
	lastError?: string;
}

export interface AgentRecord extends Omit<StoredAgent, "version"> {
	session?: AgentSession;
	opening?: Promise<AgentSession>;
	running: boolean;
	runStartedAt?: number;
	activity?: string;
	repliesThisRun: number;
	backgroundTasks: string[];
}

export function agentStatus(record: AgentRecord): AgentStatus {
	if (record.running) return "running";
	return record.session ? "idle" : "inactive";
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
