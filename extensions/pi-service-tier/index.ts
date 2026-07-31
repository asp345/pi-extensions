import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const TIERS = ["default", "flex", "priority"] as const;
type Tier = (typeof TIERS)[number];

const PROVIDERS = new Set(["openai"]);
const STATE_FILE = join(getAgentDir(), "service-tier.json");
const COMMAND = "service-tier";
const DESCRIPTIONS: Record<Tier, string> = {
	default: "project default (no service_tier sent)",
	flex: "cheaper, slower (0.5x cost)",
	priority: "faster, expensive (2x cost)",
};

function isTier(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

async function loadTier(): Promise<Tier> {
	try {
		const value: unknown = JSON.parse(await readFile(STATE_FILE, "utf8"));
		const tier = (value as { tier?: unknown }).tier;
		return typeof tier === "string" && isTier(tier) ? tier : "default";
	} catch {
		return "default";
	}
}

async function saveTier(tier: Tier): Promise<void> {
	await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
	const temporary = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ tier }, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, STATE_FILE);
	await chmod(STATE_FILE, 0o600);
}

export default async function serviceTier(pi: ExtensionAPI): Promise<void> {
	let current: Tier = await loadTier();

	pi.on("before_provider_request", (event, ctx) => {
		if (current === "default") return;
		if (!ctx.model || !PROVIDERS.has(ctx.model.provider)) return;
		if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: current };
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
		description: "Select the OpenAI service tier (default, flex, priority) applied to every model of the provider",
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
