import type { Api, Model } from "@earendil-works/pi-ai";

const LONG_CONTEXT_WINDOW = 1_050_000;

const LONG_CONTEXT_IDS = new Set(["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

export const GPT_56_ALIAS = "gpt-5.6";
export const DAYBREAK_BLUE_ALIAS = "gpt-daybreak-blue-latest";
export const DAYBREAK_SOL_ID = "gpt-5.6-sol";
function cloneCost(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return { ...cost, tiers: cost.tiers?.map((tier) => ({ ...tier })) };
}

function cloneModel(model: Model<Api>, values: Pick<Model<Api>, "id" | "name" | "contextWindow">): Model<Api> {
	return {
		...model,
		...values,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: [...model.input],
		cost: cloneCost(model.cost),
		compat: model.compat ? structuredClone(model.compat) : undefined,
	};
}

function fallbackSol(): Model<Api> {
	return {
		id: DAYBREAK_SOL_ID,
		name: "GPT-5.6 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"],
		cost: {
			input: 4,
			output: 20,
			cacheRead: 0.4,
			cacheWrite: 5,
			tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
		},
		contextWindow: LONG_CONTEXT_WINDOW,
		maxTokens: 128_000,
		compat: {
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsExplicitPromptCacheMode: true,
		},
	};
}

function buildOptionalModels(
	base: readonly Model<Api>[],
	options: { longContext?: boolean; daybreak?: boolean },
): Model<Api>[] {
	const sol = base.find((model) => model.id === DAYBREAK_SOL_ID) ?? fallbackSol();
	const contextWindow = options.longContext === false ? sol.contextWindow : LONG_CONTEXT_WINDOW;
	const models = [
		cloneModel(sol, {
			id: GPT_56_ALIAS,
			name: "GPT-5.6 (Sol alias)",
			contextWindow,
		}),
	];
	if (options.daybreak !== false) {
		models.push(
			cloneModel(sol, {
				id: DAYBREAK_BLUE_ALIAS,
				name: "GPT Daybreak Blue (Sol)",
				contextWindow,
			}),
		);
	}
	return models;
}

export function buildManagedModels(
	base: readonly Model<Api>[],
	options: { longContext?: boolean; daybreak?: boolean } = {},
): Model<Api>[] {
	const models = base.map((model) =>
		options.longContext !== false && LONG_CONTEXT_IDS.has(model.id)
			? { ...model, contextWindow: LONG_CONTEXT_WINDOW }
			: model,
	);
	const ids = new Set(models.map((model) => model.id));
	for (const extra of buildOptionalModels(models, options)) {
		if (!ids.has(extra.id)) models.push(extra);
	}
	return models;
}
