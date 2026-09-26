import { type QuotaDisplay, quotaColor, quotaSegments } from "../quota.ts";
import type { UsageLimit } from "../types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type WindowKey = "fiveHour" | "day" | "week" | "month";

function windowKey(limit: UsageLimit): WindowKey | undefined {
	const source = `${limit.id} ${limit.label} ${limit.window?.id ?? ""} ${limit.window?.label ?? ""}`.toLowerCase();
	const duration = limit.window?.durationMs;
	if (source.includes("5h") || source.includes("5 hour") || (duration && duration <= 6 * HOUR_MS)) return "fiveHour";
	if (
		source.includes("week") ||
		source.includes("7d") ||
		(duration && duration >= 6 * DAY_MS && duration <= 8 * DAY_MS)
	)
		return "week";
	if (source.includes("month") || source.includes("1mo") || (duration && duration >= 27 * DAY_MS)) return "month";
	if (
		source.includes("daily") ||
		source.includes("1d") ||
		source.includes("24h") ||
		(duration && duration <= 2 * DAY_MS)
	)
		return "day";
	return undefined;
}

export function formatUsageLimits(data: unknown): QuotaDisplay | null {
	const limits = data as UsageLimit[];
	const windows: Partial<Record<WindowKey, number>> = {};
	for (const limit of limits) {
		const key = windowKey(limit);
		const fraction = limit.remainingFraction;
		if (!key || fraction === undefined || !Number.isFinite(fraction)) continue;
		const remaining = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
		windows[key] = Math.min(windows[key] ?? 100, remaining);
	}
	const segments = quotaSegments(
		windows,
		limits.map((limit) => limit.window?.resetsAt),
	);
	if (Object.keys(segments).length === 0) return null;
	return { segments, color: quotaColor(...Object.values(windows)) };
}
