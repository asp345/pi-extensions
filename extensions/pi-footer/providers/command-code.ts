import { getJson, type QuotaPlan, quotaColor, quotaSegments } from "../quota.ts";

interface CommandCodeWindow {
	cap?: unknown;
	used?: unknown;
	resetAt?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asWindow = (value: unknown): CommandCodeWindow | undefined => (isRecord(value) ? value : undefined);

const BASE_URL = "https://api.commandcode.ai/alpha";

const COMMANDCODE_PLANS: Record<string, { monthlyCreditsUsd: number; fiveHourCapUsd: number; weeklyCapUsd: number }> = {
	"individual-go": { monthlyCreditsUsd: 10, fiveHourCapUsd: 3, weeklyCapUsd: 6 },
	"individual-goat": { monthlyCreditsUsd: 70, fiveHourCapUsd: 14, weeklyCapUsd: 35 },
	"individual-pro": { monthlyCreditsUsd: 80, fiveHourCapUsd: 16, weeklyCapUsd: 40 },
	"individual-max": { monthlyCreditsUsd: 150, fiveHourCapUsd: 45, weeklyCapUsd: 90 },
	"individual-ultra": { monthlyCreditsUsd: 300, fiveHourCapUsd: 90, weeklyCapUsd: 180 },
};

export const commandCodeQuotaPlan: QuotaPlan = {
	id: "commandcode",
	// The auth key uses user_...; model configs may identify this provider as cmd or commandcode.
	matchProviders: ["cmd", "commandcode"],
	apiKeyEnv: "COMMANDCODE_API_KEY",
	fetch: async ({ accessToken }) => {
		// Command Code's alpha billing API mirrors the official CLI protocol:
		// GET /alpha/whoami returns user information; a non-empty org.id adds ?orgId=xxx to later requests.
		// GET /alpha/billing/credits returns credits and five-hour/weekly window limits.
		// GET /alpha/billing/subscriptions returns the plan ID and current billing-period end.
		// These headers are required by some endpoints to avoid 403 responses.
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "command-code/0.38.2",
			"x-command-code-version": "0.38.2",
		};
		const whoami = await getJson(`${BASE_URL}/whoami`, headers);
		const org = isRecord(whoami) && isRecord(whoami.org) ? whoami.org : {};
		const qs = typeof org.id === "string" && org.id ? `?orgId=${encodeURIComponent(org.id)}` : "";
		const [credits, subscriptionResponse] = await Promise.all([
			getJson(`${BASE_URL}/billing/credits${qs}`, headers),
			fetch(`${BASE_URL}/billing/subscriptions${qs}`, { headers, signal: AbortSignal.timeout(5000) }),
		]);
		const subscription: unknown = subscriptionResponse.ok ? await subscriptionResponse.json() : null;
		return { credits, subscription };
	},
	format: (data) => {
		const payload = isRecord(data) ? data : {};
		const creditsPayload = isRecord(payload.credits) ? payload.credits : {};
		const credits = isRecord(creditsPayload.credits) ? creditsPayload.credits : {};
		const windows = isRecord(creditsPayload.windowLimits) ? creditsPayload.windowLimits : {};
		const fiveHour = asWindow(windows.fiveHour);
		const weekly = asWindow(windows.weekly);

		// Rolling windows report dollar amounts; remaining is (cap - used) / cap.
		const remOf = (window: CommandCodeWindow | undefined): number | null => {
			if (!window) return null;
			const cap = Number(window.cap);
			const used = Number(window.used ?? 0);
			if (!Number.isFinite(cap) || cap <= 0) return null;
			return Math.max(0, Math.min(100, ((cap - used) / cap) * 100));
		};
		const intervalRemaining = remOf(fiveHour);
		const weeklyRemaining = remOf(weekly);

		// Monthly usage only reports remaining credits; the subscription plan supplies the denominator.
		// Trust it only when the five-hour and weekly caps match the public plan catalog.
		const subscriptionPayload = isRecord(payload.subscription) ? payload.subscription : {};
		const sub = isRecord(subscriptionPayload.data) ? subscriptionPayload.data : {};
		const plan = COMMANDCODE_PLANS[String(sub.planId || "").toLowerCase()];
		const monthlyRemaining = Number(credits.monthlyCredits ?? NaN);
		let monthlyPercent: number | null = null;
		if (
			plan &&
			Number.isFinite(monthlyRemaining) &&
			monthlyRemaining <= plan.monthlyCreditsUsd &&
			fiveHour?.cap !== undefined &&
			Number(fiveHour.cap) === plan.fiveHourCapUsd &&
			weekly?.cap !== undefined &&
			Number(weekly.cap) === plan.weeklyCapUsd
		) {
			monthlyPercent = (monthlyRemaining / plan.monthlyCreditsUsd) * 100;
		}

		// Use the earliest reset among the five-hour, weekly, and monthly billing windows.
		// resetAt may be in seconds or milliseconds; values above 2e10 are treated as milliseconds.
		const resets = [fiveHour, weekly].map((window) => {
			const time = Number(window?.resetAt ?? 0);
			return time > 20000000000 ? time : time * 1000;
		});
		const periodEnd = sub.currentPeriodEnd;
		if (typeof periodEnd === "string" || typeof periodEnd === "number") resets.push(new Date(periodEnd).getTime());

		const segments = quotaSegments(
			{ fiveHour: intervalRemaining, week: weeklyRemaining, month: monthlyPercent },
			resets,
		);
		if (monthlyPercent === null && Number.isFinite(monthlyRemaining)) {
			segments.balance = `$${monthlyRemaining.toFixed(0)}`;
		}
		return { segments, color: quotaColor(intervalRemaining, weeklyRemaining, monthlyPercent) };
	},
};
