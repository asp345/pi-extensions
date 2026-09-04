import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStyle, DisplayKey, SpeedStyle } from "./config.ts";
import type { StatsConfigStore } from "./config-store.ts";
import { TOKEN_PLANS } from "./plans.ts";
import type { QuotaController } from "./quota-controller.ts";
import type { SharedState } from "./types.ts";

function registerStatsCommand(
	pi: ExtensionAPI,
	deps: { store: StatsConfigStore; quota: QuotaController; shared: SharedState },
): void {
	const { store, quota, shared } = deps;

	/** Prompt for GLM team credentials, persist them, then force a team quota refresh. */
	async function promptGlmTeamConfig(ctx: ExtensionContext): Promise<void> {
		const cur = store.loaded?.teamCredential;
		const curLabel =
			cur?.organization && cur?.project ? `${cur.organization} / ${cur.project}` : "not configured (personal query)";
		const prompts = ["✏️ Configure / Edit", "Skip"];
		const choice = await ctx.ui.select(
			`GLM team plan credentials? Current: ${curLabel}\nEnter organization and project IDs for a team query, or skip for a personal query`,
			prompts,
		);
		if (!choice || choice === prompts[1]) {
			await quota.forceRefresh(ctx);
			const errMsg = quota.state?.error ? quota.formatError() : "";
			ctx.ui.notify(
				quota.state?.error ? `GLM quota query failed: ${errMsg}` : "GLM quota enabled (personal query)",
				"info",
			);
			return;
		}

		const organization = await ctx.ui.input("Organization ID", cur?.organization ?? "");
		const project = await ctx.ui.input("Project ID", cur?.project ?? "");
		const org = organization?.trim() ?? "";
		const proj = project?.trim() ?? "";
		if (!org || !proj) {
			ctx.ui.notify("Organization/Project ID cannot be empty, credentials not saved", "warning");
			return;
		}

		await store.save({ ...store.current, teamCredential: { organization: org, project: proj } });

		await quota.forceRefresh(ctx);
		const errMsg = quota.state?.error ? quota.formatError() : "";
		ctx.ui.notify(quota.state?.error ? `GLM team quota query failed: ${errMsg}` : "GLM team quota enabled", "info");
	}

	pi.registerCommand("stats", {
		description: "Token stats settings and provider quota selection",
		handler: async (args, ctx) => {
			const arg = args.trim() || "config";

			if (arg === "limit") {
				const provider = ctx.model?.provider;
				if (!provider) {
					ctx.ui.notify("Cannot get current provider, switch conversation first", "warning");
					return;
				}
				const options = ["Off", ...TOKEN_PLANS.map((plan) => plan.name)];
				const choice = await ctx.ui.select(`Select quota plan to show for ${provider} (select to exit)`, options);

				if (!choice || choice === options[0]) {
					await store.save({ ...store.current, providerPlans: { ...store.current.providerPlans, [provider]: null } });
					await quota.forceRefresh(ctx);
					quota.restartTimer(ctx);
					shared.requestRender?.();
					ctx.ui.notify(`Quota display for ${provider} is off`, "info");
					return;
				}
				const plan = TOKEN_PLANS.find((candidate) => candidate.name === choice);
				if (plan) {
					await store.save({
						...store.current,
						providerPlans: { ...store.current.providerPlans, [provider]: plan.id },
					});
					await quota.forceRefresh(ctx);
					quota.restartTimer(ctx);
					if (plan.id === "glm") {
						await promptGlmTeamConfig(ctx);
						return;
					}
					if (quota.state?.error) {
						const errMsg = quota.formatError();
						ctx.ui.notify(`${plan.name} quota query failed: ${errMsg}`, "info");
					} else {
						ctx.ui.notify(`${plan.name} quota enabled`, "info");
					}
				}
				return;
			}

			if (arg === "config") {
				const cfgOpts = [
					"Display style",
					"Display items",
					`Refresh interval (current ${store.loaded?.ttl || 60}s)`,
					"GLM team credentials",
				];
				const subChoice = await ctx.ui.select("Settings", cfgOpts);
				if (!subChoice) return;

				if (subChoice === cfgOpts[3]) {
					const cur = store.loaded?.teamCredential;
					const label = cur?.organization && cur?.project ? `${cur.organization} / ${cur.project}` : "not configured";
					const actions = ["✏️ Configure / Edit", "Clear", "Back"];
					const action = await ctx.ui.select(`GLM team credentials (current: ${label})`, actions);
					if (!action || action === actions[2]) return;
					if (action === actions[1]) {
						await store.save({
							...store.current,
							teamCredential: { organization: "", project: "" },
						});
						await quota.forceRefresh(ctx);
						ctx.ui.notify("GLM team credentials cleared (back to personal query)", "info");
					} else {
						const organization = await ctx.ui.input("Organization ID", cur?.organization ?? "");
						const project = await ctx.ui.input("Project ID", cur?.project ?? "");
						const org = organization?.trim() ?? "";
						const proj = project?.trim() ?? "";
						if (!org || !proj) {
							ctx.ui.notify("Organization/Project ID cannot be empty, not saved", "warning");
							return;
						}
						await store.save({ ...store.current, teamCredential: { organization: org, project: proj } });
						await quota.forceRefresh(ctx);
						const errMsg = quota.state?.error ? quota.formatError() : "";
						if (quota.state?.error) {
							ctx.ui.notify(`GLM team quota query failed: ${errMsg}`, "info");
						} else {
							ctx.ui.notify("GLM team credentials saved (team query active)", "info");
						}
					}
					return;
				}

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

			ctx.ui.notify("Usage: /stats [config | limit]", "warning");
		},
	});
}

export default registerStatsCommand;
