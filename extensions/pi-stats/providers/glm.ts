import type { QuotaFetchExtra, TokenPlan } from "../quota.ts";
import { formatQuotaSegments, formatTokenPlanDisplay, type QuotaSegments } from "../quota.ts";
import { quotaColor } from "./quota-color.ts";

interface GlmQuotaEntry {
	type?: unknown;
	unit?: unknown;
	percentage?: unknown;
	nextResetTime?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const glmQuotaPlan: TokenPlan = {
	id: "glm",
	name: "GLM (Zhipu)",
	matchProviders: ["zhipu-cn", "zhipu", "glm", "bigmodel", "zai-coding-cn"],
	apiKeyEnv: "GLM_API_KEY",
	baseUrl: "https://open.bigmodel.cn",
	quotaPath: "/api/monitor/usage/quota/limit",
	authHeader: (key) => ({ Authorization: key }),
	fetchQuota: async (plan: TokenPlan, key: string, extra?: QuotaFetchExtra) => {
		const team = extra?.team;
		const headers: Record<string, string> = {
			...plan.authHeader(key),
			"Content-Type": "application/json",
		};
		// Team plans use ?type=2 and require organization and project headers.
		// The API key, organization ID, and project ID are all required; team plans are available only on open.bigmodel.cn.
		if (team) {
			headers["Bigmodel-Organization"] = team.organization;
			headers["Bigmodel-Project"] = team.project;
		}
		const url = plan.baseUrl + plan.quotaPath + (team ? "?type=2" : "");
		const r = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) throw new Error(`GLM quota query HTTP ${r.status}`);
		return await r.json();
	},
	format: (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const usage = isRecord(payload.data) ? payload.data : {};
		const limits = Array.isArray(usage.limits)
			? usage.limits.filter((entry): entry is GlmQuotaEntry => isRecord(entry))
			: [];
		// Personal plans return TOKENS_LIMIT; team plans return CREDIT_LIMIT, case-insensitively.
		const isQuota = (type: unknown) => {
			const value = String(type ?? "").toLowerCase();
			return value === "tokens_limit" || value === "credit_limit";
		};
		const entries = limits.filter((entry) => isQuota(entry.type));
		if (entries.length === 0) return { modelPrefix: "", display: "No data", segments: {}, color: "err" as const };

		// Classify windows by unit rather than array order, matching cc-switch's Zhipu tier parser:
		// unit 3 is the rolling 5h window; unit 6 is the weekly window.
		const byUnit = (unit: number) => entries.find((entry) => entry.unit === unit);
		let fiveHour: GlmQuotaEntry | null = byUnit(3) ?? null;
		let weekly: GlmQuotaEntry | null = byUnit(6) ?? null;
		// For missing or unknown units, prefer entries without nextResetTime for 5h, then fill by reset time.
		if (!fiveHour || !weekly) {
			const unclassified = entries
				.filter((entry) => entry !== fiveHour && entry !== weekly)
				.sort(
					(a, b) =>
						(typeof a.nextResetTime === "number" ? a.nextResetTime : Number.MIN_SAFE_INTEGER) -
						(typeof b.nextResetTime === "number" ? b.nextResetTime : Number.MIN_SAFE_INTEGER),
				);
			for (const entry of unclassified) {
				if (!fiveHour) fiveHour = entry;
				else if (!weekly) weekly = entry;
			}
		}

		// percentage is the used percentage, so remaining is 100 minus percentage.
		const intervalRemaining = fiveHour
			? 100 - (typeof fiveHour.percentage === "number" ? fiveHour.percentage : 0)
			: null;
		const weeklyRemaining = weekly ? 100 - (typeof weekly.percentage === "number" ? weekly.percentage : 0) : null;
		const now = Date.now();
		const resets = entries
			.map((entry) => entry.nextResetTime)
			.filter((time): time is number => typeof time === "number" && time > now);
		const nearestReset = resets.length > 0 ? Math.min(...resets) : null;

		let formatted: { display: string; segments: QuotaSegments };
		if (intervalRemaining !== null && weeklyRemaining !== null) {
			formatted = formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset);
		} else {
			const segments: QuotaSegments = {};
			if (intervalRemaining !== null) segments.fiveHour = `5h: ${Math.round(intervalRemaining)}%`;
			if (weeklyRemaining !== null) segments.week = `W: ${Math.round(weeklyRemaining)}%`;
			formatted = { display: formatQuotaSegments(segments) || "No data", segments };
		}
		const color = quotaColor(intervalRemaining, weeklyRemaining);
		return { modelPrefix: "", ...formatted, color };
	},
};
