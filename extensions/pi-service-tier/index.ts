import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const TIERS = ["default", "flex", "priority"] as const;
type Tier = (typeof TIERS)[number];

const APIS = new Set(["openai-responses", "openai-completions"]);
const STATE_VERSION = 2;
const STATE_FILE = join(getAgentDir(), "service-tier.json");
const COMMAND = "service-tier";
const BASE_PROVIDER = Symbol("pi-service-tier-base-provider");
type WrappedProvider = Provider & { [BASE_PROVIDER]: Provider };
const DESCRIPTIONS: Record<Tier, string> = {
	default: "standard processing (no service_tier sent)",
	flex: "lower-cost processing with slower or unavailable capacity",
	priority: "faster processing at premium pricing",
};

function isTier(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

async function loadTier(): Promise<Tier> {
	try {
		const value: unknown = JSON.parse(await readFile(STATE_FILE, "utf8"));
		const state = value as { version?: unknown; tier?: unknown };
		if (state.tier === "fast") return "priority";
		if (state.tier === "auto") return "default";
		return typeof state.tier === "string" && isTier(state.tier) ? state.tier : "default";
	} catch {
		return "default";
	}
}

async function saveTier(tier: Tier): Promise<void> {
	await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
	const temporary = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ version: STATE_VERSION, tier }, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, STATE_FILE);
	await chmod(STATE_FILE, 0o600);
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

export function applyTierCost(message: AssistantMessage, multiplier: number): void {
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
	if (!APIS.has(model.api) || tier === "default") return start(model, context, options);
	const output = createAssistantMessageEventStream();
	const multiplier = tierCostMultiplier(tier, model.id);
	void (async () => {
		let last: AssistantMessage | undefined;
		try {
			const inner = start(model, context, optionsWithTier(options, tier));
			for await (const event of inner) {
				last = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
				if (model.api !== "openai-responses") {
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

function wrapProvider(base: Provider, getTier: () => Tier): WrappedProvider {
	return {
		...base,
		[BASE_PROVIDER]: base,
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

export default async function serviceTier(pi: ExtensionAPI): Promise<void> {
	let current: Tier = await loadTier();

	pi.on("session_start", (_event, ctx) => {
		const currentProvider = ctx.modelRegistry.getProvider("openai") as WrappedProvider | undefined;
		const base = currentProvider?.[BASE_PROVIDER] ?? currentProvider;
		if (base) pi.registerProvider(wrapProvider(base, () => current));
	});

	const describe = (): string =>
		TIERS.map((tier) => `${tier === current ? "→" : " "} ${tier} · ${DESCRIPTIONS[tier]}`).join("\n");

	async function select(ctx: ExtensionContext): Promise<void> {
		const value = await ctx.ui.select(
			`OpenAI service tier (current: ${current})`,
			TIERS.map((tier) => `${tier} · ${DESCRIPTIONS[tier]}`),
		);
		const tier = value?.split(" ")[0];
		if (!tier || !isTier(tier) || tier === current) return;
		await apply(ctx, tier);
	}

	async function apply(ctx: ExtensionContext, tier: Tier): Promise<void> {
		current = tier;
		await saveTier(tier);
		ctx.ui.notify(`OpenAI service tier: ${tier} · ${DESCRIPTIONS[tier]}`, "info");
	}

	pi.registerCommand(COMMAND, {
		description: "Select the OpenAI service tier applied to compatible direct OpenAI requests",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				if (ctx.hasUI) return select(ctx);
				return ctx.ui.notify(describe(), "info");
			}
			if (!isTier(value)) {
				return ctx.ui.notify(`Usage: /${COMMAND} [${TIERS.join("|")}]\n${describe()}`, "warning");
			}
			await apply(ctx, value);
		},
	});
}
