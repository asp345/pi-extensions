import { getJson, type QuotaPlan, quotaColor, quotaSegments } from "../quota.ts";

interface GlmQuotaEntry {
	type?: unknown;
	unit?: unknown;
	percentage?: unknown;
	nextResetTime?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const glmQuotaPlan: QuotaPlan = {
	id: "glm",
	matchProviders: ["zhipu-cn", "zhipu", "glm", "bigmodel", "zai-coding-cn"],
	apiKeyEnv: "GLM_API_KEY",
	fetch: ({ accessToken }) =>
		getJson("https://open.bigmodel.cn/api/monitor/usage/quota/limit", { Authorization: accessToken }),
	format: (data) => {
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
		if (entries.length === 0) return null;

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
		const remaining = (entry: GlmQuotaEntry | null) =>
			entry ? 100 - (typeof entry.percentage === "number" ? entry.percentage : 0) : null;
		const intervalRemaining = remaining(fiveHour);
		const weeklyRemaining = remaining(weekly);
		return {
			segments: quotaSegments(
				{ fiveHour: intervalRemaining, week: weeklyRemaining },
				entries.map((entry) => entry.nextResetTime),
			),
			color: quotaColor(intervalRemaining, weeklyRemaining),
		};
	},
};
