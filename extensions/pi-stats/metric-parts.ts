import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { DisplayConfig } from "./config.ts";
import { formatTokenSpeed, formatTokens } from "./format.ts";
import type { QuotaController } from "./quota-controller.ts";
import type { UsageAccountant } from "./usage-accountant.ts";

export interface MetricPartOptions {
	speed?: boolean;
	quota?: boolean;
}

/** Footer metric segments, excluding run timing which index.ts appends. */
export function renderMetricParts(params: {
	theme: Theme;
	ctx: ExtensionContext;
	accountant: UsageAccountant;
	displayConfig: DisplayConfig;
	quota: QuotaController;
	options?: MetricPartOptions;
}): string[] {
	const { theme, ctx, accountant, quota, options = {} } = params;
	const displayConfig = params.displayConfig;
	const dim = (s: string) => theme.fg("dim", s);
	const warn = (s: string) => theme.fg("warning", s);
	const ok = dim;
	const muted = dim;

	const parts: string[] = [];
	const cfg = displayConfig.items;

	{
		const segParts: string[] = [];
		if (cfg.input) segParts.push(`↑${formatTokens(accountant.totalInput)}`);
		if (cfg.output) segParts.push(`↓${formatTokens(accountant.totalOutput)}`);
		if (cfg.totalTokens) {
			const total = accountant.totalInput + accountant.totalOutput;
			segParts.push(`Σ${formatTokens(total)}`);
		}
		if (cfg.cost) segParts.push(`$${accountant.totalCost.toFixed(4)}`);
		if (cfg.cacheHit) {
			const totalPrompt = accountant.totalInput + accountant.totalCacheRead + accountant.totalCacheWrite;
			const cumCH = totalPrompt > 0 ? (accountant.totalCacheRead / totalPrompt) * 100 : 0;
			segParts.push(`${dim("CH")}${dim(`${cumCH.toFixed(1)}%`)}`);
		}
		if (segParts.length > 0) parts.push(segParts.join(" "));
	}

	if (cfg.speed && options.speed !== false) {
		const liveSpeed = accountant.sampleDisplaySpeed(Date.now());
		const displaySpeed = liveSpeed ?? accountant.lastLiveTokenSpeed ?? accountant.lastTokensPerSec;
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
				if (accountant.streaming && liveSpeed !== null) {
					parts.push(`⚡${formatTokens(accountant.liveEstimatedTokens)}@${speedNum}`);
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

function progressBar(pct: number, width = 8): string {
	const filled = Math.round((Math.min(pct, 100) / 100) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
