import { formatDuration, formatQuotaSegments, type QuotaSegments, type TokenPlan } from "../quota.ts";
import { quotaColor } from "./quota-color.ts";

interface OpenCodeUsageWindow {
	status: "ok";
	percent: number;
	resetsAt?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isUsageWindow = (value: unknown): value is OpenCodeUsageWindow =>
	isRecord(value) && value.status === "ok" && typeof value.percent === "number";

export const openCodeGoQuotaPlan: TokenPlan = {
	id: "opencode-go",
	name: "OpenCode Go",
	matchProviders: ["opencode-go"],
	apiKeyEnv: "OPENCODE_API_KEY",
	baseUrl: "https://opencode.ai",
	quotaPath: "/zen/go/v1/usage",
	authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	fetchQuota: async (plan: TokenPlan, key: string) => {
		const r = await fetch(plan.baseUrl + plan.quotaPath, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) throw new Error(`OpenCode Go quota query HTTP ${r.status}`);
		return await r.json();
	},
	format: (data: unknown) => {
		// The official /v1/usage endpoint reports percent used; remaining is 100 minus percent.
		const payload = isRecord(data) ? data : {};
		const usage = isRecord(payload.usage) ? payload.usage : payload;
		const win = (key: string): OpenCodeUsageWindow | null => {
			const value = usage[key];
			return isUsageWindow(value) ? value : null;
		};
		const rolling = win("rolling");
		const weekly = win("weekly");
		const monthly = win("monthly");
		if (!rolling && !weekly && !monthly) {
			return { modelPrefix: "", display: "No data", segments: {}, color: "err" as const };
		}
		const now = Date.now();
		const resets = [rolling, weekly, monthly]
			.filter((window): window is OpenCodeUsageWindow => window !== null)
			.map((window) => {
				const time = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
				return Number.isFinite(time) && time > now ? time : null;
			})
			.filter((time): time is number => time !== null);
		const nearestReset = resets.length > 0 ? Math.min(...resets) : null;

		const rem = (window: OpenCodeUsageWindow | null): number | null => (window ? 100 - window.percent : null);
		const r = rem(rolling);
		const weeklyRemaining = rem(weekly);
		const monthlyRemaining = rem(monthly);
		const segments: QuotaSegments = {};
		if (r !== null) segments.fiveHour = `5h: ${Math.round(r)}%`;
		if (weeklyRemaining !== null) segments.week = `W: ${Math.round(weeklyRemaining)}%`;
		if (monthlyRemaining !== null) segments.month = `M: ${Math.round(monthlyRemaining)}%`;
		if (nearestReset) {
			const diff = nearestReset - now;
			if (diff > 0 && diff < 30 * 24 * 60 * 60 * 1000) segments.reset = formatDuration(diff);
		}
		const color = quotaColor(r, weeklyRemaining, monthlyRemaining);
		return { modelPrefix: "", display: formatQuotaSegments(segments), segments, color };
	},
};
