import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";

const TIERS = ["default", "flex", "priority"] as const;
export type Tier = (typeof TIERS)[number];

const APIS = new Set(["openai-responses", "openai-codex-responses"]);
export function isTier(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

export function applyTierToPayload(payload: unknown, tier: Tier): unknown | undefined {
	if (tier === "default" || payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	return { ...payload, service_tier: tier };
}

function optionsWithTier<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	tier: Tier,
): T | undefined {
	if (!APIS.has(model.api) || tier === "default" || (tier === "flex" && model.api === "openai-codex-responses")) {
		return options;
	}
	const originalPayload = options?.onPayload;
	return {
		...(options ?? ({} as T)),
		serviceTier: tier,
		onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
			const transformed = (await originalPayload?.(payload, payloadModel)) ?? payload;
			return applyTierToPayload(transformed, tier) ?? transformed;
		},
	} as T;
}

export function tierStreamWrappers(base: Provider, getTier: () => Tier): Pick<Provider, "stream" | "streamSimple"> {
	return {
		stream: (model, context, options) => base.stream(model, context, optionsWithTier(model, options, getTier())),
		streamSimple: (model, context, options) =>
			base.streamSimple(model, context, optionsWithTier(model, options, getTier())),
	};
}
