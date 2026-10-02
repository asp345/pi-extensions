import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { DisplayConfig } from "./config.ts";
import { formatTokenSpeed, formatTokens } from "./format.ts";
import type { QuotaController } from "./quota-controller.ts";
import type { UsageAccountant } from "./usage-accountant.ts";

export interface MetricPartOptions {
	speed?: boolean;
	quota?: boolean;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface SessionStats {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "usage") return entry.usage;
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
}

function computeSessionStats(ctx: ExtensionContext): SessionStats {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage = entryUsage(entry);
		if (!usage) continue;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost?.total ?? 0;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
		}
	}
	return { totals, latestCacheHitRate, contextUsage: ctx.getContextUsage() };
}

export function cachedSessionStats(): (ctx: ExtensionContext) => SessionStats {
	let cached:
		| { sessionId: string; leafId: string | null; model: Model<Api> | undefined; stats: SessionStats }
		| undefined;
	return (ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const leafId = ctx.sessionManager.getLeafId();
		const model = ctx.model;
		if (cached?.sessionId !== sessionId || cached.leafId !== leafId || cached.model !== model) {
			cached = { sessionId, leafId, model, stats: computeSessionStats(ctx) };
		}
		return cached.stats;
	};
}

function usingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
	return (
		ctx.modelRegistry.isUsingOAuth(model) &&
		ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true
	);
}

export function renderMetricParts(params: {
	theme: Theme;
	ctx: ExtensionContext;
	stats: SessionStats;
	accountant: UsageAccountant;
	displayConfig: DisplayConfig;
	quota: QuotaController;
	options?: MetricPartOptions;
}): string[] {
	const { theme, ctx, stats, accountant, displayConfig, quota, options = {} } = params;
	const dim = (s: string) => theme.fg("dim", s);
	const warn = (s: string) => theme.fg("warning", s);
	const error = (s: string) => theme.fg("error", s);

	const parts: string[] = [];
	const cfg = displayConfig.items;

	const { totals, latestCacheHitRate } = stats;
	const segParts: string[] = [];
	if (cfg.input) segParts.push(`↑${formatTokens(totals.input)}`);
	if (cfg.output) segParts.push(`↓${formatTokens(totals.output)}`);
	if (cfg.cacheRead && totals.cacheRead > 0) segParts.push(`R${formatTokens(totals.cacheRead)}`);
	if (cfg.cacheWrite && totals.cacheWrite > 0) segParts.push(`W${formatTokens(totals.cacheWrite)}`);
	if (cfg.totalTokens) segParts.push(`Σ${formatTokens(totals.input + totals.output)}`);
	if (cfg.cost) segParts.push(`$${totals.cost.toFixed(4)}${usingSubscription(ctx) ? " (sub)" : ""}`);
	if (cfg.cacheHit && (totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		segParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	if (segParts.length > 0) parts.push(dim(segParts.join(" ")));

	if (cfg.speed && options.speed !== false) {
		parts.push(dim(`⚡${formatTokenSpeed(accountant.lastTokensPerSec)} ${displayConfig.speedStyle}`));
	}

	if (cfg.context) {
		const cu = stats.contextUsage;
		const ctxWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const ctxPercent = typeof cu?.percent === "number" ? cu.percent : null;
		if (ctxWindow > 0 && ctxPercent !== null) {
			const ctxUsed = Math.round((ctxWindow * ctxPercent) / 100);
			const ctxStr = {
				"pct-window": `${ctxPercent.toFixed(1)}%/${formatTokens(ctxWindow)}`,
				"used-window": `${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`,
				pct: `${ctxPercent.toFixed(1)}%`,
				used: formatTokens(ctxUsed),
				bar: `${progressBar(ctxPercent)} ${ctxPercent.toFixed(1)}%`,
			}[displayConfig.contextStyle];
			const ctxColor = ctxPercent < 75 ? dim : ctxPercent < 85 ? warn : error;
			parts.push(ctxColor(ctxStr));
		} else {
			parts.push(dim(ctxWindow > 0 ? `?/${formatTokens(ctxWindow)}` : `0%/0`));
		}
	}

	const quotaState = quota.state;
	if (options.quota !== false && quotaState) {
		if (quotaState === "no-data") {
			parts.push(dim("No data"));
		} else {
			const { segments, color } = quotaState;
			const enabledSegments = [
				cfg.quota5h ? segments.fiveHour : undefined,
				cfg.quotaDay ? segments.day : undefined,
				cfg.quotaWeek ? segments.week : undefined,
				cfg.quotaMonth ? segments.month : undefined,
				cfg.quotaBalance ? segments.balance : undefined,
				cfg.quotaClock ? segments.reset : undefined,
			].filter((segment): segment is string => Boolean(segment));
			const qColor = color === "ok" ? dim : color === "warn" ? warn : error;
			if (enabledSegments.length > 0) parts.push(qColor(enabledSegments.join(" ")));
		}
	}

	return parts;
}

function progressBar(pct: number, width = 8): string {
	const filled = Math.round((Math.min(pct, 100) / 100) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
