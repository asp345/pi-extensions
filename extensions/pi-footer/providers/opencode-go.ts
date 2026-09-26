import { getJson, type QuotaPlan, quotaColor, quotaSegments } from "../quota.ts";

interface OpenCodeUsageWindow {
	status: "ok";
	percent: number;
	resetsAt?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isUsageWindow = (value: unknown): value is OpenCodeUsageWindow =>
	isRecord(value) && value.status === "ok" && typeof value.percent === "number";

export const openCodeGoQuotaPlan: QuotaPlan = {
	id: "opencode-go",
	matchProviders: ["opencode-go"],
	apiKeyEnv: "OPENCODE_API_KEY",
	fetch: ({ accessToken }) =>
		getJson("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${accessToken}` }),
	format: (data) => {
		// The official /v1/usage endpoint reports percent used; remaining is 100 minus percent.
		const payload = isRecord(data) ? data : {};
		const usage = isRecord(payload.usage) ? payload.usage : payload;
		const windows = [usage.rolling, usage.weekly, usage.monthly].map((value) => (isUsageWindow(value) ? value : null));
		if (windows.every((window) => window === null)) return null;
		const [rolling, weekly, monthly] = windows.map((window) => (window ? 100 - window.percent : null));
		const resets = windows.map((window) =>
			typeof window?.resetsAt === "string" ? Date.parse(window.resetsAt) : undefined,
		);
		return {
			segments: quotaSegments({ fiveHour: rolling, week: weekly, month: monthly }, resets),
			color: quotaColor(rolling, weekly, monthly),
		};
	},
};
