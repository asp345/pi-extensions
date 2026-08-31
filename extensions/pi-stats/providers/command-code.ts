import { formatDuration, formatQuotaSegments, type QuotaSegments, type TokenPlan } from "../quota.ts";

interface CommandCodeWindow {
	cap?: unknown;
	used?: unknown;
	resetAt?: unknown;
}

interface CommandCodeWhoamiResponse {
	org?: {
		id?: unknown;
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asWindow = (value: unknown): CommandCodeWindow | undefined => (isRecord(value) ? value : undefined);

export const commandCodeQuotaPlan: TokenPlan = {
	id: "commandcode",
	name: "Command Code",
	// The auth key uses user_...; model configs may identify this provider as cmd or commandcode.
	matchProviders: ["cmd", "commandcode"],
	apiKeyEnv: "COMMANDCODE_API_KEY",
	baseUrl: "https://api.commandcode.ai",
	quotaPath: "/alpha/billing/credits",
	authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	fetchQuota: async (plan: TokenPlan, key: string) => {
		// Command Code's alpha billing API mirrors the official CLI protocol:
		// GET /alpha/whoami returns user information; a non-empty org.id adds ?orgId=xxx to later requests.
		// GET /alpha/billing/credits returns credits and five-hour/weekly window limits.
		// GET /alpha/billing/subscriptions returns the plan ID and current billing-period end.
		// These headers are required by some endpoints to avoid 403 responses.
		const headers: Record<string, string> = {
			...plan.authHeader(key),
			"Content-Type": "application/json",
			"User-Agent": "command-code/0.38.2",
			"x-command-code-version": "0.38.2",
		};
		const whoami = await fetch(`${plan.baseUrl}/alpha/whoami`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(5000),
		});
		if (!whoami.ok) throw new Error(`Command Code whoami query HTTP ${whoami.status}`);
		const whoamiData = (await whoami.json()) as CommandCodeWhoamiResponse;
		const orgId = typeof whoamiData.org?.id === "string" ? whoamiData.org.id : undefined;
		const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

		const [creditsR, subR] = await Promise.all([
			fetch(plan.baseUrl + plan.quotaPath + qs, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(5000),
			}),
			fetch(`${plan.baseUrl}/alpha/billing/subscriptions${qs}`, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(5000),
			}).catch(() => null),
		]);
		if (!creditsR.ok) throw new Error(`Command Code quota query HTTP ${creditsR.status}`);
		const creditsData = await creditsR.json();
		let subData: unknown = null;
		if (subR?.ok) {
			try {
				subData = await subR.json();
			} catch {
				subData = null;
			}
		}
		return { credits: creditsData, subscription: subData };
	},
	format: (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const creditsPayload = isRecord(payload.credits) ? payload.credits : {};
		const credits = isRecord(creditsPayload.credits) ? creditsPayload.credits : {};
		const windows = isRecord(creditsPayload.windowLimits) ? creditsPayload.windowLimits : {};
		const fiveHour = asWindow(windows.fiveHour);
		const weekly = asWindow(windows.weekly);

		// Rolling windows report dollar amounts; remaining is (cap - used) / cap.
		const remOf = (window: CommandCodeWindow | undefined): number | null => {
			if (!window || !isRecord(window)) return null;
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
		const planId = String(sub.planId || "").toLowerCase();
		const plan = COMMANDCODE_PLANS[planId as keyof typeof COMMANDCODE_PLANS];
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
		const now = Date.now();
		const resets: number[] = [];
		for (const window of [fiveHour, weekly]) {
			const time = Number(window?.resetAt ?? 0);
			if (Number.isFinite(time) && time > 0) {
				const milliseconds = time > 20000000000 ? time : time * 1000;
				if (milliseconds > now) resets.push(milliseconds);
			}
		}
		const periodEnd = sub.currentPeriodEnd;
		if (typeof periodEnd === "string" || typeof periodEnd === "number") {
			const milliseconds = new Date(periodEnd).getTime();
			if (Number.isFinite(milliseconds) && milliseconds > now) resets.push(milliseconds);
		}
		const nearestReset = resets.length > 0 ? Math.min(...resets) : null;

		const segments: QuotaSegments = {};
		if (intervalRemaining !== null) segments.fiveHour = `5h: ${Math.round(intervalRemaining)}%`;
		if (weeklyRemaining !== null) segments.week = `W: ${Math.round(weeklyRemaining)}%`;
		if (monthlyPercent !== null) segments.month = `M: ${Math.round(monthlyPercent)}%`;
		if (monthlyPercent === null && Number.isFinite(monthlyRemaining)) {
			segments.balance = `$${monthlyRemaining.toFixed(0)}`;
		}
		if (nearestReset) {
			const diff = nearestReset - now;
			if (diff > 0 && diff < 30 * 24 * 60 * 60 * 1000) segments.reset = formatDuration(diff);
		}
		const low = (value: number | null) => value !== null && value < 20;
		const mid = (value: number | null) => value !== null && value < 50;
		const color =
			low(intervalRemaining) || low(weeklyRemaining) || low(monthlyPercent)
				? ("err" as const)
				: mid(intervalRemaining) || mid(weeklyRemaining) || mid(monthlyPercent)
					? ("warn" as const)
					: ("ok" as const);
		const display = formatQuotaSegments(segments) || "No quota data";
		return { modelPrefix: "", display, segments, color };
	},
};

const COMMANDCODE_PLANS: Record<
	string,
	{ label: string; monthlyCreditsUsd: number; fiveHourCapUsd: number; weeklyCapUsd: number }
> = {
	"individual-go": { label: "Go", monthlyCreditsUsd: 10, fiveHourCapUsd: 3, weeklyCapUsd: 6 },
	"individual-goat": { label: "GOAT", monthlyCreditsUsd: 70, fiveHourCapUsd: 14, weeklyCapUsd: 35 },
	"individual-pro": { label: "Pro", monthlyCreditsUsd: 80, fiveHourCapUsd: 16, weeklyCapUsd: 40 },
	"individual-max": { label: "Max 10x", monthlyCreditsUsd: 150, fiveHourCapUsd: 45, weeklyCapUsd: 90 },
	"individual-ultra": { label: "Max 20x", monthlyCreditsUsd: 300, fiveHourCapUsd: 90, weeklyCapUsd: 180 },
};
