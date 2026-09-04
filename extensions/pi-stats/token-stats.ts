import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type ContextStyle,
	DEFAULT_CONFIG,
	DEFAULT_DISPLAY_CONFIG,
	type DisplayConfig,
	type DisplayKey,
	loadConfig,
	type PiStatsConfig,
	type SpeedStyle,
	saveConfig,
} from "./config.ts";
import { estimateTokens, isReasonableTokenSpeed } from "./estimate.ts";
import { formatTokenSpeed, formatTokens } from "./format.ts";
import { ActiveTokenSpeed } from "./live-speed.ts";
import { TOKEN_PLANS } from "./plans.ts";
import { QuotaController } from "./quota-controller.ts";

export interface SharedState {
	/** Whether the session is active. Set by session_start and session_shutdown. */
	sessionActive: boolean;
	/** Footer render callback, cleared when the footer or session closes. */
	requestRender: (() => void) | null;
}

const LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS = 1_000;

export interface MetricPartOptions {
	speed?: boolean;
	quota?: boolean;
}

export interface TokenStatsHandle {
	/** Status-bar metrics excluding run timing, which index.ts appends. */
	getMetricParts(theme: Theme, ctx: ExtensionContext, options?: MetricPartOptions): string[];
}

export function createTokenStats(pi: ExtensionAPI, shared: SharedState): TokenStatsHandle {
	const stats = {
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		turnStartTime: 0,
		streaming: false,
		lastTokensPerSec: 0, // Average output rate
		lastLiveTokenSpeed: null as number | null, // Rolling-window speed
		displayedLiveTokenSpeed: null as number | null,
		lastSpeedDisplayAt: 0,
		lastSpeedRenderRequestAt: 0,
		liveOutputChars: 0,
		liveEstimatedTokens: 0,
		liveUsageOutputTokens: 0,
		// Deduplicate message_end and turn_end usage records.
		accountedUsageKeys: new Set<string>(),
	};
	const speedTracker = new ActiveTokenSpeed();

	let tokenConfig: PiStatsConfig | null = null;

	let displayConfig: DisplayConfig = {
		...DEFAULT_DISPLAY_CONFIG,
		items: { ...DEFAULT_DISPLAY_CONFIG.items },
	};
	const quota = new QuotaController({
		getConfig: () => tokenConfig ?? { ...DEFAULT_CONFIG, display: displayConfig },
		isSessionActive: () => shared.sessionActive,
		requestRender: () => shared.requestRender?.(),
	});
	function progressBar(pct: number, width = 8): string {
		const filled = Math.round((Math.min(pct, 100) / 100) * width);
		return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
	}

	function resetLiveState() {
		stats.liveOutputChars = 0;
		stats.liveEstimatedTokens = 0;
		stats.liveUsageOutputTokens = 0;
		speedTracker.reset();
		stats.displayedLiveTokenSpeed = null;
		stats.lastSpeedDisplayAt = 0;
		stats.lastSpeedRenderRequestAt = 0;
	}

	function getMetricParts(theme: Theme, ctx: ExtensionContext, options: MetricPartOptions = {}): string[] {
		const dim = (s: string) => theme.fg("dim", s);
		const warn = (s: string) => theme.fg("warning", s);
		const ok = dim;
		const muted = dim;

		const parts: string[] = [];
		const cfg = displayConfig.items;

		{
			const segParts: string[] = [];
			if (cfg.input) segParts.push(`↑${formatTokens(stats.totalInput)}`);
			if (cfg.output) segParts.push(`↓${formatTokens(stats.totalOutput)}`);
			if (cfg.totalTokens) {
				const total = stats.totalInput + stats.totalOutput;
				segParts.push(`Σ${formatTokens(total)}`);
			}
			if (cfg.cost) segParts.push(`$${stats.totalCost.toFixed(4)}`);
			if (cfg.cacheHit) {
				const totalPrompt = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
				const cumCH = totalPrompt > 0 ? (stats.totalCacheRead / totalPrompt) * 100 : 0;
				const chColor = dim;
				segParts.push(`${dim("CH")}${chColor(`${cumCH.toFixed(1)}%`)}`);
			}
			if (segParts.length > 0) parts.push(segParts.join(" "));
		}

		if (cfg.speed && options.speed !== false) {
			let liveSpeed = stats.displayedLiveTokenSpeed;
			const nowMs = Date.now();
			if (stats.streaming && nowMs - stats.lastSpeedDisplayAt >= LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS) {
				const sampledSpeed = speedTracker.getSpeed();
				if (sampledSpeed !== null) stats.displayedLiveTokenSpeed = sampledSpeed;
				stats.lastSpeedDisplayAt = nowMs;
				liveSpeed = stats.displayedLiveTokenSpeed;
			}
			const displaySpeed = liveSpeed ?? stats.lastLiveTokenSpeed ?? stats.lastTokensPerSec;
			const speedNum = formatTokenSpeed(displaySpeed);
			const speedStyle = displayConfig.speedStyle ?? "t/s";
			switch (speedStyle) {
				case "tok/s":
					parts.push(`⚡${speedNum} tok/s`);
					break;
				case "T/s":
					parts.push(`⚡${speedNum} T/s`);
					break;
				case "liveAt":
					if (stats.streaming && liveSpeed !== null) {
						parts.push(`⚡${formatTokens(stats.liveEstimatedTokens)}@${speedNum}`);
					} else {
						parts.push(`⚡${speedNum} t/s`);
					}
					break;
				default:
					parts.push(`⚡${speedNum} t/s`);
					break;
			}
		}

		if (cfg.context) {
			try {
				const cu = ctx.getContextUsage();
				const ctxWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const ctxPercent = typeof cu?.percent === "number" ? cu.percent : null;
				const ctxUsed = ctxPercent !== null && ctxWindow > 0 ? Math.round((ctxWindow * ctxPercent) / 100) : 0;
				const ctxStyle = displayConfig.contextStyle ?? "pct-window";
				let ctxStr: string;
				if (ctxWindow > 0 && ctxPercent !== null) {
					switch (ctxStyle) {
						case "used-window":
							ctxStr = `${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`;
							break;
						case "pct":
							ctxStr = `${ctxPercent.toFixed(1)}%`;
							break;
						case "used":
							ctxStr = formatTokens(ctxUsed);
							break;
						case "bar":
							ctxStr = `${progressBar(ctxPercent)} ${ctxPercent.toFixed(1)}%`;
							break;
						default:
							ctxStr = `${ctxPercent.toFixed(1)}%/${formatTokens(ctxWindow)}`;
							break;
					}
				} else {
					ctxStr = ctxWindow > 0 ? `?/${formatTokens(ctxWindow)}` : `0%/0`;
				}
				const ctxColor =
					ctxPercent !== null && ctxWindow > 0
						? ctxPercent < 75
							? dim
							: ctxPercent < 85
								? warn
								: (s: string) => theme.fg("error", s)
						: dim;
				parts.push(ctxColor(ctxStr));
			} catch {
				/* ignore */
			}
		}

		quota.handleProviderChange(ctx);
		const quotaState = quota.state;
		if (options.quota !== false && quotaState?.display) {
			const qColor =
				quotaState.color === "ok"
					? ok
					: quotaState.color === "warn"
						? warn
						: quotaState.color === "err"
							? (s: string) => theme.fg("error", s)
							: muted;
			const prefix = quotaState.modelPrefix ? `${quotaState.modelPrefix} ` : "";

			if (quotaState.error) {
				parts.push(qColor(prefix + quotaState.display));
			} else {
				const enabledSegments = [
					cfg.quota5h ? quotaState.segments.fiveHour : undefined,
					cfg.quotaDay ? quotaState.segments.day : undefined,
					cfg.quotaWeek ? quotaState.segments.week : undefined,
					cfg.quotaMonth ? quotaState.segments.month : undefined,
					cfg.quotaBalance ? quotaState.segments.balance : undefined,
					cfg.quotaClock ? quotaState.segments.reset : undefined,
				].filter((segment): segment is string => Boolean(segment));
				if (enabledSegments.length > 0) parts.push(qColor(prefix + enabledSegments.join(" ")));
			}
		}

		return parts.map((part) => theme.fg("dim", part));
	}

	function normalizeTimestampMs(timestamp: number): number {
		// Normalize mixed timestamp units to milliseconds.
		if (timestamp < 1e11) return timestamp * 1000; // seconds → ms
		if (timestamp > 1e14) return Math.floor(timestamp / 1000); // microsec → ms
		return timestamp;
	}

	function getEntryTimestampMs(entry: {
		type: string;
		timestamp: string;
		message?: { timestamp?: number };
	}): number | null {
		if (entry.type === "message" && typeof entry.message?.timestamp === "number") {
			return normalizeTimestampMs(entry.message.timestamp);
		}
		const parsed = Date.parse(entry.timestamp);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function rebuildFromHistory(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		stats.totalInput = 0;
		stats.totalOutput = 0;
		stats.totalCacheRead = 0;
		stats.totalCacheWrite = 0;
		stats.totalCost = 0;
		stats.accountedUsageKeys = new Set();
		stats.lastTokensPerSec = 0;

		// Rebuild cumulative totals and estimate historical speed.
		let latestAssistantSpeed: number | null = null;

		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant" || !msg.usage) continue;

			stats.totalInput += msg.usage.input ?? 0;
			stats.totalOutput += msg.usage.output ?? 0;
			stats.totalCacheRead += msg.usage.cacheRead ?? 0;
			stats.totalCacheWrite += msg.usage.cacheWrite ?? 0;
			stats.totalCost += msg.usage.cost?.total ?? 0;

			// Estimate speed from the preceding non-assistant message.
			if ((msg.usage.output ?? 0) <= 0) continue;
			const endMs = getEntryTimestampMs(entry);
			if (endMs === null) continue;

			for (let j = branch.indexOf(entry) - 1; j >= 0; j--) {
				const prev = branch[j];
				if (prev.type !== "message") continue;
				const prevMsg = prev.message;
				if (prevMsg.role === "assistant") continue; // Skip assistant-to-assistant deltas.

				const startMs = getEntryTimestampMs(prev);
				if (startMs === null || endMs <= startMs) continue;

				const elapsedSeconds = (endMs - startMs) / 1000;
				if (elapsedSeconds <= 0) continue;

				const speed = (msg.usage.output ?? 0) / elapsedSeconds;
				if (!isReasonableTokenSpeed(speed)) continue;

				if (prevMsg.role === "user") {
					latestAssistantSpeed = speed;
					break;
				}
				// Fall back to non-user messages.
				if (latestAssistantSpeed === null) latestAssistantSpeed = speed;
			}
		}

		if (latestAssistantSpeed !== null) {
			stats.lastTokensPerSec = latestAssistantSpeed;
		}
	}

	async function saveTokenConfig(config: PiStatsConfig): Promise<void> {
		tokenConfig = { ...config, display: displayConfig };
		await saveConfig(tokenConfig);
	}

	async function saveDisplayConfig(config: DisplayConfig): Promise<void> {
		displayConfig = config;
		tokenConfig = { ...(tokenConfig ?? DEFAULT_CONFIG), display: config };
		await saveConfig(tokenConfig);
	}

	/** Return the base config shape when no config has been loaded. */
	function baseTokenConfig(): PiStatsConfig {
		return { ...(tokenConfig ?? DEFAULT_CONFIG), display: displayConfig };
	}

	/**
	 * Prompt for GLM team credentials, persist them, then force a team quota refresh.
	 */
	async function promptGlmTeamConfig(ctx: ExtensionContext): Promise<void> {
		const cur = tokenConfig?.teamCredential;
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

		tokenConfig = {
			...baseTokenConfig(),
			teamCredential: { organization: org, project: proj },
		};
		await saveTokenConfig(tokenConfig);

		await quota.forceRefresh(ctx);
		const errMsg = quota.state?.error ? quota.formatError() : "";
		ctx.ui.notify(quota.state?.error ? `GLM team quota query failed: ${errMsg}` : "GLM team quota enabled", "info");
	}

	pi.on("turn_start", (_event, ctx) => {
		stats.turnStartTime = Date.now();
		stats.streaming = false;

		quota.handleProviderChange(ctx);

		shared.requestRender?.();
	});

	pi.on("message_update", (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const content = event.message.content;
		if (!Array.isArray(content)) return;

		const streamEvent = (
			event as typeof event & {
				assistantMessageEvent?: {
					type?: string;
					delta: string;
					partial?: { usage?: { output?: number } };
				};
			}
		).assistantMessageEvent;
		if (
			streamEvent?.type !== "text_delta" &&
			streamEvent?.type !== "thinking_delta" &&
			streamEvent?.type !== "toolcall_delta"
		) {
			stats.streaming = true;
			return;
		}

		stats.streaming = true;

		const nowMs = Date.now();
		stats.liveOutputChars += streamEvent.delta.length;

		const usageOutputTokens = streamEvent.partial?.usage?.output;
		let newTokens = 0;
		if (typeof usageOutputTokens === "number" && usageOutputTokens > stats.liveUsageOutputTokens) {
			newTokens = usageOutputTokens - stats.liveUsageOutputTokens;
			stats.liveUsageOutputTokens = usageOutputTokens;
			stats.liveEstimatedTokens = usageOutputTokens;
		} else if (stats.liveUsageOutputTokens <= 0) {
			const estimated = estimateTokens(stats.liveOutputChars);
			newTokens = Math.max(0, estimated - stats.liveEstimatedTokens);
			stats.liveEstimatedTokens = estimated;
		}

		if (newTokens > 0) {
			speedTracker.add(newTokens, nowMs);
		}

		if (nowMs - stats.lastSpeedRenderRequestAt >= LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS) {
			stats.lastSpeedRenderRequestAt = nowMs;
			shared.requestRender?.();
		}
	});

	pi.on("message_end", (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const assistantMsg = event.message as AssistantMessage;
		const usage = assistantMsg.usage;
		if (!usage) return;

		const usageKey =
			assistantMsg.responseId ||
			`${assistantMsg.timestamp}:${assistantMsg.provider}:${assistantMsg.model}:${usage.input}:${usage.output}`;
		if (stats.accountedUsageKeys.has(usageKey)) return;
		stats.accountedUsageKeys.add(usageKey);

		const totalElapsed = stats.turnStartTime > 0 ? (Date.now() - stats.turnStartTime) / 1000 : 0;
		const tokensPerSec = totalElapsed >= 0.05 ? usage.output / totalElapsed : 0;
		const liveSpeed = speedTracker.getSpeed();
		const cost = usage.cost?.total ?? 0;

		stats.lastTokensPerSec = tokensPerSec;
		stats.lastLiveTokenSpeed = liveSpeed ?? stats.lastLiveTokenSpeed;
		stats.streaming = false;

		stats.totalInput += usage.input;
		stats.totalOutput += usage.output;
		stats.totalCacheRead += usage.cacheRead;
		stats.totalCacheWrite += usage.cacheWrite;
		stats.totalCost += cost;

		shared.requestRender?.();

		resetLiveState();
	});

	pi.on("agent_end", (_event, _ctx) => {
		stats.streaming = false;
		resetLiveState();
		shared.requestRender?.();
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		// Clear timers and captured contexts before Pi invalidates the session context.
		shared.sessionActive = false;
		quota.stop();
		shared.requestRender = null;
	});

	pi.on("session_start", async (_event, ctx) => {
		shared.sessionActive = true;
		rebuildFromHistory(ctx);

		tokenConfig = await loadConfig();
		displayConfig = tokenConfig.display;
		quota.start(ctx);
	});

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

				const defaults = baseTokenConfig();
				if (!choice || choice === options[0]) {
					tokenConfig = tokenConfig
						? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: null } }
						: { ...defaults, providerPlans: { [provider]: null } };
					await saveTokenConfig(tokenConfig);
					await quota.forceRefresh(ctx);
					quota.restartTimer(ctx);
					shared.requestRender?.();
					ctx.ui.notify(`Quota display for ${provider} is off`, "info");
					return;
				}
				const plan = TOKEN_PLANS.find((candidate) => candidate.name === choice);
				if (plan) {
					tokenConfig = tokenConfig
						? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: plan.id } }
						: { ...defaults, providerPlans: { [provider]: plan.id } };
					await saveTokenConfig(tokenConfig);
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
					`Refresh interval (current ${tokenConfig?.ttl || 60}s)`,
					"GLM team credentials",
				];
				const subChoice = await ctx.ui.select("Settings", cfgOpts);
				if (!subChoice) return;

				if (subChoice === cfgOpts[3]) {
					const cur = tokenConfig?.teamCredential;
					const label = cur?.organization && cur?.project ? `${cur.organization} / ${cur.project}` : "not configured";
					const actions = ["✏️ Configure / Edit", "Clear", "Back"];
					const action = await ctx.ui.select(`GLM team credentials (current: ${label})`, actions);
					if (!action || action === actions[2]) return;
					if (action === actions[1]) {
						tokenConfig = {
							...baseTokenConfig(),
							teamCredential: { organization: "", project: "" },
						};
						await saveTokenConfig(tokenConfig);
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
						tokenConfig = {
							...baseTokenConfig(),
							teamCredential: { organization: org, project: proj },
						};
						await saveTokenConfig(tokenConfig);
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
							`Context style (current: ${displayConfig.contextStyle})`,
							items.map((i) => `${(displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}`),
						);
						if (choice) {
							const idx = items.findIndex(
								(i) => `${(displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}` === choice,
							);
							if (idx >= 0) {
								displayConfig = { ...displayConfig, contextStyle: items[idx].value };
								await saveDisplayConfig(displayConfig);
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
							`⚡ Speed style (current: ${displayConfig.speedStyle})`,
							items.map((i) => `${(displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}`),
						);
						if (choice) {
							const idx = items.findIndex(
								(i) => `${(displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}` === choice,
							);
							if (idx >= 0) {
								displayConfig = { ...displayConfig, speedStyle: items[idx].value };
								await saveDisplayConfig(displayConfig);
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
						const options = itemLabels.map((k) => `${displayConfig.items[k] ? "✅" : "⬜"} ${itemNames[k]}`);
						options.push("🔙 Done");
						const choice = await ctx.ui.select("Select items to toggle", options);
						if (!choice || choice === options[options.length - 1]) break;
						const idx = options.indexOf(choice);
						if (idx >= 0 && idx < itemLabels.length) {
							const key = itemLabels[idx];
							displayConfig = {
								...displayConfig,
								items: { ...displayConfig.items, [key]: !displayConfig.items[key] },
							};
							await saveDisplayConfig(displayConfig);
							shared.requestRender?.();
						}
					}
					ctx.ui.notify("Status bar display config saved", "info");
				} else if (subChoice === cfgOpts[2]) {
					const input = await ctx.ui.input("Refresh interval in seconds", String(tokenConfig?.ttl || 60));
					if (input) {
						const sec = parseInt(input, 10);
						if (Number.isNaN(sec) || sec < 10) {
							ctx.ui.notify("Refresh interval must be >= 10s", "warning");
						} else {
							tokenConfig = { ...baseTokenConfig(), ttl: sec };
							await saveTokenConfig(tokenConfig);
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

	return {
		getMetricParts,
	};
}
