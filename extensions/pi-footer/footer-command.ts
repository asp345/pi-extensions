import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextStyle, DisplayKey, SpeedStyle } from "./config.ts";
import type { FooterConfigStore } from "./config-store.ts";
import type { QuotaController } from "./quota-controller.ts";
import type { SharedState } from "./types.ts";

function registerFooterCommand(
	pi: ExtensionAPI,
	deps: { store: FooterConfigStore; quota: QuotaController; shared: SharedState },
): void {
	const { store, quota, shared } = deps;

	pi.registerCommand("footer", {
		description: "Footer display settings",
		handler: async (args, ctx) => {
			const arg = args.trim() || "config";

			if (arg === "config") {
				const cfgOpts = ["Display style", "Display items", `Refresh interval (current ${store.loaded?.ttl || 60}s)`];
				const subChoice = await ctx.ui.select("Settings", cfgOpts);
				if (!subChoice) return;

				if (subChoice === cfgOpts[0]) {
					const catOpts = ["Context style", "⚡ Speed style"];
					const catChoice = await ctx.ui.select("Select style category to configure", catOpts);
					if (!catChoice) return;

					if (catChoice === catOpts[0]) {
						const items: { label: string; value: ContextStyle; preview: string }[] = [
							{ label: "pct-window", value: "pct-window", preview: `5.3%/1.0M` },
							{ label: "used-window", value: "used-window", preview: `256k/1.0M` },
							{ label: "pct", value: "pct", preview: `5.3%` },
							{ label: "used", value: "used", preview: `256k` },
							{ label: "bar", value: "bar", preview: `[██░░░░░░] 25%` },
						];
						const choice = await ctx.ui.select(
							`Context style (current: ${store.display.contextStyle})`,
							items.map((i) => `${(store.display.contextStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}`),
						);
						if (choice) {
							const idx = items.findIndex(
								(i) => `${(store.display.contextStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}` === choice,
							);
							if (idx >= 0) {
								await store.saveDisplay({ ...store.display, contextStyle: items[idx].value });
								shared.requestRender?.();
							}
						}
					} else {
						const items: { label: string; value: SpeedStyle; preview: string }[] = [
							{ label: "t/s", value: "t/s", preview: `⚡77.7 t/s` },
							{ label: "tok/s", value: "tok/s", preview: `⚡77.7 tok/s` },
							{ label: "T/s", value: "T/s", preview: `⚡77.7 T/s` },
							{ label: "live@rate", value: "liveAt", preview: `⚡1.2k@77.7` },
						];
						const choice = await ctx.ui.select(
							`⚡ Speed style (current: ${store.display.speedStyle})`,
							items.map((i) => `${(store.display.speedStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}`),
						);
						if (choice) {
							const idx = items.findIndex(
								(i) => `${(store.display.speedStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}` === choice,
							);
							if (idx >= 0) {
								await store.saveDisplay({ ...store.display, speedStyle: items[idx].value });
								shared.requestRender?.();
							}
						}
					}
					ctx.ui.notify("Display style saved", "info");
				} else if (subChoice === cfgOpts[1]) {
					const itemLabels: DisplayKey[] = [
						"input",
						"output",
						"totalTokens",
						"cost",
						"cacheHit",
						"speed",
						"context",
						"quota5h",
						"quotaDay",
						"quotaWeek",
						"quotaMonth",
						"quotaBalance",
						"quotaClock",
					];
					const itemNames: Record<DisplayKey, string> = {
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
					while (true) {
						const options = itemLabels.map((k) => `${store.display.items[k] ? "✅" : "⬜"} ${itemNames[k]}`);
						options.push("🔙 Done");
						const choice = await ctx.ui.select("Select items to toggle", options);
						if (!choice || choice === options[options.length - 1]) break;
						const idx = options.indexOf(choice);
						if (idx >= 0 && idx < itemLabels.length) {
							const key = itemLabels[idx];
							await store.saveDisplay({
								...store.display,
								items: { ...store.display.items, [key]: !store.display.items[key] },
							});
							shared.requestRender?.();
						}
					}
					ctx.ui.notify("Status bar display config saved", "info");
				} else if (subChoice === cfgOpts[2]) {
					const input = await ctx.ui.input("Refresh interval in seconds", String(store.loaded?.ttl || 60));
					if (input) {
						const sec = parseInt(input, 10);
						if (Number.isNaN(sec) || sec < 10) {
							ctx.ui.notify("Refresh interval must be >= 10s", "warning");
						} else {
							await store.save({ ...store.current, ttl: sec });
							quota.restartTimer(ctx);
							ctx.ui.notify(`Refresh interval set to ${sec}s`, "info");
						}
					}
				}
				return;
			}

			ctx.ui.notify("Usage: /footer [config]", "warning");
		},
	});
}

export default registerFooterCommand;
