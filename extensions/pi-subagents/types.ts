import type { RpcMessage, RpcProcess } from "./rpc.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentStatus = "running" | "completed" | "stopped" | "error";

export interface AgentRecord {
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
	model?: string;
	thinking?: ThinkingLevel;
	messages: RpcMessage[];
	proc?: RpcProcess;
	sessionFile?: string;
	abortController: AbortController;
	pendingSteers: string[];
	promise?: Promise<void>;
	resultConsumed?: boolean;
}

export interface RunRequest {
	id: string;
	title: string;
	prompt: string;
	model?: string;
	thinking?: ThinkingLevel;
	cwd: string;
	parentSignal?: AbortSignal;
}
