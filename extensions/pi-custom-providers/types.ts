import type { Api, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const API_OPTIONS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const satisfies readonly Api[];

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_TOKENS = 256_000;

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
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
}

export interface CustomProvidersFile {
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
}
