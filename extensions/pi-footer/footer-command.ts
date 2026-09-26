import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type ContextStyle,
	DEFAULT_DISPLAY_CONFIG,
	type DisplayConfig,
	type DisplayKey,
	type FooterConfigStore,
	type SpeedStyle,
} from "./config.ts";
import type { QuotaController } from "./quota-controller.ts";

interface StyleOption<T extends string> {
	label: string;
	value: T;
	preview: string;
}

const CONTEXT_STYLE_OPTIONS: StyleOption<ContextStyle>[] = [
	{ label: "pct-window", value: "pct-window", preview: `5.3%/1.0M` },
	{ label: "used-window", value: "used-window", preview: `256k/1.0M` },
	{ label: "pct", value: "pct", preview: `5.3%` },
	{ label: "used", value: "used", preview: `256k` },
	{ label: "bar", value: "bar", preview: `[██░░░░░░] 25%` },
];

const SPEED_STYLE_OPTIONS: StyleOption<SpeedStyle>[] = [
	{ label: "t/s", value: "t/s", preview: `⚡77.7 t/s` },
	{ label: "tok/s", value: "tok/s", preview: `⚡77.7 tok/s` },
	{ label: "T/s", value: "T/s", preview: `⚡77.7 T/s` },
	{ label: "live@rate", value: "liveAt", preview: `⚡1.2k@77.7` },
];

const ITEM_NAMES: Record<DisplayKey, string> = {
	input: "Input",
	output: "Output",
	totalTokens: "Total tokens",
	cost: "Cost",
	cacheHit: "Cache hit",
	speed: "Speed",
	context: "Context",
	quota5h: "5h quota",
	quotaDay: "Daily quota",
	quotaWeek: "Weekly quota",
	quotaMonth: "Monthly quota",
	quotaBalance: "Balance",
	quotaClock: "Reset time",
};

async function pickStyle<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	current: T,
	items: StyleOption<T>[],
): Promise<T | undefined> {
	const options = items.map((item) => `${current === item.value ? "● " : "○ "}${item.label}  ${item.preview}`);
	const choice = await ctx.ui.select(`${title} (current: ${current})`, options);
	return choice ? items[options.indexOf(choice)]?.value : undefined;
}

export default function registerFooterCommand(
	pi: ExtensionAPI,
	store: FooterConfigStore,
	quota: QuotaController,
	requestRender: () => void,
): void {
	const saveDisplay = async (display: DisplayConfig) => {
		await store.save({ ...store.config, display });
		requestRender();
	};

	pi.registerCommand("footer", {
		description: "Footer display settings",
		handler: async (args, ctx) => {
			if ((args.trim() || "config") !== "config") {
				ctx.ui.notify("Usage: /footer [config]", "warning");
				return;
			}

			const cfgOpts = ["Display style", "Display items", `Refresh interval (current ${store.config.ttl}s)`];
			const subChoice = await ctx.ui.select("Settings", cfgOpts);
			if (!subChoice) return;

			if (subChoice === cfgOpts[0]) {
				const catOpts = ["Context style", "⚡ Speed style"];
				const catChoice = await ctx.ui.select("Select style category to configure", catOpts);
				if (!catChoice) return;
				const display = store.config.display;
				if (catChoice === catOpts[0]) {
					const contextStyle = await pickStyle(ctx, "Context style", display.contextStyle, CONTEXT_STYLE_OPTIONS);
					if (contextStyle) await saveDisplay({ ...display, contextStyle });
				} else {
					const speedStyle = await pickStyle(ctx, "⚡ Speed style", display.speedStyle, SPEED_STYLE_OPTIONS);
					if (speedStyle) await saveDisplay({ ...display, speedStyle });
				}
				ctx.ui.notify("Display style saved", "info");
			} else if (subChoice === cfgOpts[1]) {
				const keys = Object.keys(DEFAULT_DISPLAY_CONFIG.items) as DisplayKey[];
				while (true) {
					const items = store.config.display.items;
					const options = keys.map((key) => `${items[key] ? "✅" : "⬜"} ${ITEM_NAMES[key]}`);
					options.push("🔙 Done");
					const choice = await ctx.ui.select("Select items to toggle", options);
					const key = choice ? keys[options.indexOf(choice)] : undefined;
					if (!key) break;
					await saveDisplay({ ...store.config.display, items: { ...items, [key]: !items[key] } });
				}
				ctx.ui.notify("Status bar display config saved", "info");
			} else if (subChoice === cfgOpts[2]) {
				const input = await ctx.ui.input("Refresh interval in seconds", String(store.config.ttl));
				if (!input) return;
				const sec = parseInt(input, 10);
				if (Number.isNaN(sec) || sec < 10) {
					ctx.ui.notify("Refresh interval must be >= 10s", "warning");
					return;
				}
				await store.save({ ...store.config, ttl: sec });
				quota.restartTimer(ctx);
				ctx.ui.notify(`Refresh interval set to ${sec}s`, "info");
			}
		},
	});
}
