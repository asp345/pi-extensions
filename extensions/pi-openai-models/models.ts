import type { Api, Model } from "@earendil-works/pi-ai";

const LONG_CONTEXT_WINDOW = 1_050_000;

export const DAYBREAK_BLUE_ID = "gpt-daybreak-blue-latest";

const LONG_CONTEXT_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	DAYBREAK_BLUE_ID,
]);

function daybreakBlue(provider: string): Model<Api> {
	const codex = provider === "openai-codex";
	return {
		id: DAYBREAK_BLUE_ID,
		name: "GPT Daybreak Blue",
		api: codex ? "openai-codex-responses" : "openai-responses",
		provider,
		baseUrl: codex ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap: {
			off: codex ? undefined : "none",
			minimal: codex ? "low" : null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"],
		cost: codex
			? {
					input: 5,
					output: 30,
					cacheRead: 0.5,
					cacheWrite: 6.25,
					tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
				}
			: {
					input: 4,
					output: 20,
					cacheRead: 0.4,
					cacheWrite: 5,
					tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
				},
		contextWindow: 272_000,
		maxTokens: 128_000,
		compat: {
			supportsStrictMode: !codex,
			supportsOpenAIGrammarTools: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsExplicitPromptCacheMode: !codex,
		},
	};
}

export function buildManagedModels(
	base: readonly Model<Api>[],
	provider: string,
	options: { longContext?: boolean; daybreak?: boolean } = {},
): Model<Api>[] {
	const models = [...base];
	if (options.daybreak !== false && !models.some((model) => model.id === DAYBREAK_BLUE_ID)) {
		models.push(daybreakBlue(provider));
	}
	return models.map((model) =>
		options.longContext !== false && LONG_CONTEXT_IDS.has(model.id)
			? { ...model, contextWindow: LONG_CONTEXT_WINDOW }
			: model,
	);
}
