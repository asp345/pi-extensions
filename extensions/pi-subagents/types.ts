import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingSetting = ThinkingLevel | "parent";
export type AgentStatus = "queued" | "running" | "completed" | "cancelled" | "error";
export type Selection = true | false | string[];

export interface AgentDefinition {
	name: string;
	description: string;
	displayName?: string;
	tools: string[];
	extensions: Selection;
	excludeExtensions: string[];
	skills: Selection;
	models: string[];
	thinking?: ThinkingSetting;
	maxTurns?: number;
	persistSession: boolean;
	outputTranscript: boolean;
	sessionDir?: string;
	promptMode: "replace" | "append";
	fork: boolean;
	runInBackground: boolean;
	memory?: "user" | "project" | "local";
	worktree: boolean;
	enabled: boolean;
	path: string;
	source: "default" | "global" | "workspace" | "project";
}

export interface DefinitionRegistry {
	definitions: Map<string, AgentDefinition>;
	errors: string[];
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface WorktreeInfo {
	root: string;
	cwd: string;
	branch: string;
	base: string;
}

export interface AgentRecord {
	id: string;
	type: string;
	prompt: string;
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
	usage: Usage;
	session?: AgentSession;
	abortController: AbortController;
	pendingSteers: string[];
	promise?: Promise<void>;
	worktree?: WorktreeInfo;
	worktreeBranch?: string;
	outputFile?: string;
	resultConsumed?: boolean;
}

export interface RunRequest {
	id: string;
	definition: AgentDefinition;
	prompt: string;
	model?: string;
	maxTurns?: number;
	fork: boolean;
	cwd: string;
	configCwd: string;
	parentSignal?: AbortSignal;
	worktree?: WorktreeInfo;
}
