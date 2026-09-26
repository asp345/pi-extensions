import { getJson, type QuotaPlan, quotaColor, quotaSegments } from "../quota.ts";

interface KimiLimitDetail {
	limit?: unknown;
	remaining?: unknown;
	resetTime?: unknown;
}

interface KimiLimit {
	detail?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const resetMs = (value: unknown): unknown => (typeof value === "string" ? Date.parse(value) : value);

export const kimiQuotaPlan: QuotaPlan = {
	id: "kimi",
	matchProviders: ["moonshot-cn", "moonshot", "kimi"],
	apiKeyEnv: "MOONSHOT_API_KEY",
	fetch: ({ accessToken }) =>
		getJson("https://api.kimi.com/coding/v1/usages", { Authorization: `Bearer ${accessToken}` }),
	format: (data) => {
		const payload = isRecord(data) ? data : {};
		const limits = Array.isArray(payload.limits)
			? payload.limits.filter((limit): limit is KimiLimit => isRecord(limit))
			: [];
		const resets: unknown[] = [];
		let intervalRemaining = 100;
		if (limits.length > 0) {
			const d = isRecord(limits[0].detail) ? (limits[0].detail as KimiLimitDetail) : {};
			const limit = typeof d.limit === "number" && d.limit ? d.limit : 1;
			const remaining = Math.max(typeof d.remaining === "number" ? d.remaining : 0, 0);
			intervalRemaining = (remaining / limit) * 100;
			resets.push(resetMs(d.resetTime));
		}
		const usage = isRecord(payload.usage) ? (payload.usage as KimiLimitDetail) : {};
		let weeklyRemaining = 100;
		if (typeof usage.limit === "number" && usage.limit) {
			const remaining = Math.max(typeof usage.remaining === "number" ? usage.remaining : 0, 0);
			weeklyRemaining = (remaining / usage.limit) * 100;
			resets.push(resetMs(usage.resetTime));
		}
		if (intervalRemaining >= 100 && weeklyRemaining >= 100) return null;
		return {
			segments: quotaSegments({ fiveHour: intervalRemaining, week: weeklyRemaining }, resets),
			color: quotaColor(intervalRemaining, weeklyRemaining),
		};
	},
};
