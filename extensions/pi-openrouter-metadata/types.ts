import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type OpenRouterModel = Model<"openai-completions">;

export type CostOverride = Partial<Pick<OpenRouterModel["cost"], "input" | "output" | "cacheRead" | "cacheWrite">>;

export interface MetadataOverride {
	name?: string;
	reasoning?: true;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ("text" | "image")[];
	cost?: CostOverride;
	contextWindow?: number;
	maxTokens?: number;
}
