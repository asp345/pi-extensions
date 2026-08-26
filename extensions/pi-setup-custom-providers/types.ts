import type { Api, ModelThinkingLevel, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const API_OPTIONS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const satisfies readonly Api[];

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

export type LimitSource = "detected" | "default" | "manual";

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CustomModelConfig {
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ("text" | "image")[];
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
	limitSource?: LimitSource;
	compat?: OpenAICompletionsCompat;
	headers?: Record<string, string>;
}

export interface CustomProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: OpenAICompletionsCompat;
	/** Listing value × multiplier = USD per million tokens; "auto" detects the scale. */
	priceMultiplier?: number | "auto";
	models?: CustomModelConfig[];
}

export interface ModelsFile {
	providers: Record<string, CustomProviderConfig>;
}

export interface ModelMetadata {
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ("text" | "image")[];
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
	contextDetected?: boolean;
	maxTokensDetected?: boolean;
}
