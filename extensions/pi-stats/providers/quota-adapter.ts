import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCredential } from "../auth.ts";
import { formatQuotaSegments, type QuotaSegments, type TokenPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit, UsageProvider, UsageReport } from "../types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type WindowKey = "5h" | "D" | "W" | "M";

function remainingPercent(limit: UsageLimit): number | undefined {
	const fraction =
		limit.amount.remainingFraction ??
		(limit.amount.usedFraction === undefined ? undefined : 1 - limit.amount.usedFraction);
	if (fraction === undefined || !Number.isFinite(fraction)) return undefined;
	return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

function windowKey(limit: UsageLimit): WindowKey | undefined {
	const source = `${limit.id} ${limit.label} ${limit.window?.id ?? ""} ${limit.window?.label ?? ""}`.toLowerCase();
	const duration = limit.window?.durationMs;
	if (source.includes("5h") || source.includes("5 hour") || (duration && duration <= 6 * HOUR_MS)) return "5h";
	if (
		source.includes("week") ||
		source.includes("7d") ||
		(duration && duration >= 6 * DAY_MS && duration <= 8 * DAY_MS)
	)
		return "W";
	if (source.includes("month") || source.includes("1mo") || (duration && duration >= 27 * DAY_MS)) return "M";
	if (
		source.includes("daily") ||
		source.includes("1d") ||
		source.includes("24h") ||
		(duration && duration <= 2 * DAY_MS)
	)
		return "D";
	return undefined;
}

function resetLabel(limits: readonly UsageLimit[]): string | undefined {
	const now = Date.now();
	const resetAt = limits
		.map((limit) => limit.window?.resetsAt)
		.filter((value): value is number => typeof value === "number" && value > now)
		.sort((a, b) => a - b)[0];
	if (!resetAt) return undefined;
	const minutes = Math.max(1, Math.floor((resetAt - now) / 60_000));
	if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
	return `${minutes}m`;
}

export function formatProviderQuota(report: UsageReport) {
	const windows = new Map<WindowKey, number>();
	for (const limit of report.limits) {
		const key = windowKey(limit);
		const remaining = remainingPercent(limit);
		if (!key || remaining === undefined) continue;
		windows.set(key, Math.min(windows.get(key) ?? 100, remaining));
	}

	const segments: QuotaSegments = {};
	for (const [key, value] of windows) {
		const segmentKey = key === "5h" ? "fiveHour" : key === "D" ? "day" : key === "W" ? "week" : "month";
		segments[segmentKey] = `${key}: ${value}%`;
	}
	const reset = resetLabel(report.limits);
	if (reset) segments.reset = reset;
	const display = formatQuotaSegments(segments);
	if (!display) return { modelPrefix: "", display: "No quota data", segments: {}, color: "err" as const };

	const minimum = Math.min(...windows.values());
	return {
		modelPrefix: "",
		display,
		segments,
		color: minimum < 20 ? ("err" as const) : minimum < 50 ? ("warn" as const) : ("ok" as const),
	};
}

async function fetchReport(
	provider: UsageProvider,
	credentialIds: readonly string[],
	ctx: ExtensionContext,
): Promise<UsageReport> {
	let credential: ResolvedCredential | undefined;
	for (const id of credentialIds) {
		credential = await resolveCredential(id, ctx);
		if (credential) break;
	}
	if (!credential) throw new Error(`Missing credentials for ${credentialIds.join(" or ")}`);
	const report = await provider.fetchUsage(credential, ctx.signal);
	if (!report) throw new Error(`${provider.id} returned no quota data`);
	return report;
}

export function createProviderQuotaPlan(args: {
	id: string;
	name: string;
	matchProviders: string[];
	apiKeyEnv: string;
	provider: UsageProvider;
	credentialIds?: string[];
}): TokenPlan {
	return {
		id: args.id,
		name: args.name,
		matchProviders: args.matchProviders,
		apiKeyEnv: args.apiKeyEnv,
		baseUrl: "",
		quotaPath: "",
		authHeader: () => ({}),
		async fetchQuota() {
			throw new Error("Context-aware quota fetch required");
		},
		fetchQuotaWithContext: (ctx) => fetchReport(args.provider, args.credentialIds ?? args.matchProviders, ctx),
		format: (data) => formatProviderQuota(data as UsageReport),
	};
}
