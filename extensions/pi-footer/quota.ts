import { formatDuration } from "../shared/format.ts";
import type { ResolvedCredential } from "./types.ts";

type PercentKey = "fiveHour" | "day" | "week" | "month";

export type QuotaSegments = Partial<Record<PercentKey | "balance" | "reset", string>>;

export type QuotaColor = "ok" | "warn" | "err";

export interface QuotaDisplay {
	segments: QuotaSegments;
	color: QuotaColor;
}

export interface QuotaPlan {
	id: string;
	matchProviders: string[];
	apiKeyEnv?: string;
	fetch(credential: ResolvedCredential, signal?: AbortSignal): Promise<unknown>;
	format(data: unknown): QuotaDisplay | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERCENT_LABELS: Record<PercentKey, string> = { fiveHour: "5h", day: "D", week: "W", month: "M" };

export function quotaSegments(
	remaining: Partial<Record<PercentKey, number | null>>,
	resets: readonly unknown[] = [],
): QuotaSegments {
	const segments: QuotaSegments = {};
	for (const key of Object.keys(PERCENT_LABELS) as PercentKey[]) {
		const value = remaining[key];
		if (typeof value === "number") segments[key] = `${PERCENT_LABELS[key]}: ${Math.round(value)}%`;
	}
	const now = Date.now();
	const nearest = Math.min(...resets.filter((time): time is number => typeof time === "number" && time > now));
	if (nearest - now < 30 * DAY_MS) segments.reset = formatDuration(nearest - now);
	return segments;
}

export function quotaColor(...remainings: Array<number | null | undefined>): QuotaColor {
	const minimum = Math.min(...remainings.filter((value): value is number => typeof value === "number"));
	if (minimum < 10) return "err";
	if (minimum < 20) return "warn";
	return "ok";
}

export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, {
		headers: { ...headers, "Content-Type": "application/json" },
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}
