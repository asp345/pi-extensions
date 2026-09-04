import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";

const TIERS = ["default", "flex", "priority"] as const;
export type Tier = (typeof TIERS)[number];

const APIS = new Set(["openai-responses", "openai-completions", "openai-codex-responses"]);
export function isTier(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

export function applyTierToPayload(payload: unknown, tier: Tier): unknown | undefined {
	if (tier === "default" || payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	return { ...payload, service_tier: tier };
}

export function tierCostMultiplier(tier: Tier, modelId: string): number {
	if (tier === "flex") return 0.5;
	if (tier === "priority") return modelId === "gpt-5.5" ? 2.5 : 2;
	return 1;
}

function applyTierCost(message: AssistantMessage, multiplier: number): void {
	if (multiplier === 1) return;
	const cost = message.usage.cost;
	cost.input *= multiplier;
	cost.output *= multiplier;
	cost.cacheRead *= multiplier;
	cost.cacheWrite *= multiplier;
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

function optionsWithTier<T extends StreamOptions>(options: T | undefined, tier: Tier): T {
	const originalPayload = options?.onPayload;
	return {
		...(options ?? ({} as T)),
		serviceTier: tier === "default" ? undefined : tier,
		onPayload: async (payload: unknown, model: Model<Api>) => {
			const replacement = await originalPayload?.(payload, model);
			const transformed = replacement === undefined ? payload : replacement;
			return applyTierToPayload(transformed, tier) ?? transformed;
		},
	} as T;
}

function emptyErrorMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function streamWithTier(
	start: (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: StreamOptions | undefined,
	tier: Tier,
): AssistantMessageEventStream {
	const effectiveTier = tier === "flex" && model.api === "openai-codex-responses" ? "default" : tier;
	if (!APIS.has(model.api) || effectiveTier === "default") return start(model, context, options);
	const output = createAssistantMessageEventStream();
	const multiplier = tierCostMultiplier(effectiveTier, model.id);
	void (async () => {
		let last: AssistantMessage | undefined;
		try {
			const inner = start(model, context, optionsWithTier(options, effectiveTier));
			for await (const event of inner) {
				last = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
				if (model.api === "openai-completions") {
					if (event.type === "done") applyTierCost(event.message, multiplier);
					if (event.type === "error") applyTierCost(event.error, multiplier);
				}
				output.push(event);
			}
		} catch (error) {
			const aborted = options?.signal?.aborted === true;
			const message = last ?? emptyErrorMessage(model, error, aborted);
			message.stopReason = aborted ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			output.push({ type: "error", reason: message.stopReason, error: message });
		} finally {
			output.end();
		}
	})();
	return output;
}

export function tierStreamWrappers(base: Provider, getTier: () => Tier): Pick<Provider, "stream" | "streamSimple"> {
	return {
		stream: (model, context, options) => streamWithTier(base.stream.bind(base), model, context, options, getTier()),
		streamSimple: (model, context, options) =>
			streamWithTier(
				base.streamSimple.bind(base) as (
					model: Model<Api>,
					context: Context,
					options?: SimpleStreamOptions,
				) => AssistantMessageEventStream,
				model,
				context,
				options,
				getTier(),
			),
	};
}
