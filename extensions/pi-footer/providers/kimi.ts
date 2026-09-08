import { formatTokenPlanDisplay, type TokenPlan } from "../quota.ts";
import { quotaColor } from "./quota-color.ts";

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

export const kimiQuotaPlan: TokenPlan = {
	id: "kimi",
	name: "Kimi",
	matchProviders: ["moonshot-cn", "moonshot", "kimi"],
	apiKeyEnv: "MOONSHOT_API_KEY",
	baseUrl: "https://api.kimi.com",
	quotaPath: "/coding/v1/usages",
	authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	fetchQuota: async (plan: TokenPlan, key: string) => {
		const r = await fetch(plan.baseUrl + plan.quotaPath, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) throw new Error(`Kimi quota query HTTP ${r.status}`);
		return await r.json();
	},
	format: (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const limits = Array.isArray(payload.limits)
			? payload.limits.filter((limit): limit is KimiLimit => isRecord(limit))
			: [];
		let intervalRemaining = 100;
		let nearestReset: number | null = null;
		if (limits.length > 0) {
			const d = isRecord(limits[0].detail) ? (limits[0].detail as KimiLimitDetail) : {};
			const limit = typeof d.limit === "number" && d.limit ? d.limit : 1;
			const remainingValue = typeof d.remaining === "number" ? d.remaining : 0;
			const remaining = Math.max(remainingValue, 0);
			intervalRemaining = (remaining / limit) * 100;
			const resetTime = d.resetTime;
			if (resetTime) {
				const ms = typeof resetTime === "string" ? new Date(resetTime).getTime() : resetTime;
				if (typeof ms === "number" && ms > Date.now()) nearestReset = ms;
			}
		}
		const usage = isRecord(payload.usage) ? (payload.usage as KimiLimitDetail) : {};
		let weeklyRemaining = 100;
		const usageLimit = typeof usage.limit === "number" ? usage.limit : undefined;
		if (usageLimit) {
			const remainingValue = typeof usage.remaining === "number" ? usage.remaining : 0;
			const remaining = Math.max(remainingValue, 0);
			weeklyRemaining = (remaining / usageLimit) * 100;
			const resetTime = usage.resetTime;
			if (resetTime) {
				const ms = typeof resetTime === "string" ? new Date(resetTime).getTime() : resetTime;
				if (typeof ms === "number" && (nearestReset === null || ms < nearestReset)) nearestReset = ms;
			}
		}
		if (intervalRemaining >= 100 && weeklyRemaining >= 100) {
			return { modelPrefix: "", display: "No data", segments: {}, color: "err" as const };
		}
		const formatted = formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset);
		return {
			modelPrefix: "",
			...formatted,
			color: quotaColor(intervalRemaining, weeklyRemaining),
		};
	},
};
