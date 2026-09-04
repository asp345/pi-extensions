import type { Api, Model, Provider } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "github-copilot";
export const AUTO_MODEL_ID = "auto";
export const AUTO_PREFIX = "auto-";
export const BASE_PROVIDER = "__piConfigCopilotAutoBase" as const;
export type WrappedProvider = Provider & { [BASE_PROVIDER]?: Provider };

export const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

export function realModelId(id: string): string {
	return id.startsWith(AUTO_PREFIX) ? id.slice(AUTO_PREFIX.length) : id;
}

export function apiForModel(id: string): Api {
	if (/^claude-(haiku|sonnet|opus)-[45]([.-]|$)/.test(id)) return "anthropic-messages";
	if (id.startsWith("gpt-5") || id.startsWith("oswe") || id.startsWith("mai-")) return "openai-responses";
	return "openai-completions";
}

export function poolModel(id: string, name: string, api: Api): Model<Api> {
	const anthropic = api === "anthropic-messages";
	const responses = api === "openai-responses";
	let compat: Record<string, unknown>;
	if (anthropic) {
		compat = { supportsEagerToolInputStreaming: false };
	} else if (responses) {
		compat = {
			supportsReasoningEffort: true,
			supportsStore: false,
			supportsStrictMode: true,
			sessionAffinityFormat: "openai",
		};
	} else {
		compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}
	return {
		id,
		name,
		api,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: responses,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: anthropic ? 64_000 : 128_000,
		thinkingLevelMap: responses
			? {
					off: "none",
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: null,
					max: null,
				}
			: undefined,
		compat,
	};
}
