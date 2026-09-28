import { isRecord, toNumber } from "../../shared/json.ts";
import type { QuotaPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit } from "../types.ts";
import { formatUsageLimits } from "./quota-adapter.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

function parseIsoMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercent(value: unknown): number | undefined {
	const percent = toNumber(value);
	return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}

function parseAmount(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const amount = toNumber(value.val);
	return amount !== undefined && amount >= 0 ? amount : undefined;
}

function weeklyLimits(raw: Record<string, unknown>): UsageLimit[] | null {
	if (!isRecord(raw.currentPeriod)) return null;
	const start = parseIsoMs(raw.currentPeriod.start);
	const end = parseIsoMs(raw.currentPeriod.end);
	const type = typeof raw.currentPeriod.type === "string" ? raw.currentPeriod.type : "";
	if (start === undefined || end === undefined || end <= start || !type.toUpperCase().includes("WEEK")) return null;

	const creditUsagePercent = parsePercent(raw.creditUsagePercent);
	if (creditUsagePercent === undefined) return null;
	if (raw.productUsage !== undefined && !Array.isArray(raw.productUsage)) return null;

	const window = { id: "1w", label: "Weekly", durationMs: WEEK_MS, resetsAt: end };
	const limits: UsageLimit[] = [
		{ id: "xai:credits:1w", label: "Weekly", window, remainingFraction: 1 - creditUsagePercent / 100 },
	];
	for (const item of raw.productUsage ?? []) {
		if (!isRecord(item)) continue;
		const product = typeof item.product === "string" ? item.product.trim() : "";
		const usagePercent = parsePercent(item.usagePercent);
		if (!product || usagePercent === undefined) continue;
		limits.push({ id: "xai:product:1w", label: "Weekly", window, remainingFraction: 1 - usagePercent / 100 });
	}
	return limits;
}

function monthlyLimits(raw: Record<string, unknown>): UsageLimit[] | null {
	const start = parseIsoMs(raw.billingPeriodStart);
	const end = parseIsoMs(raw.billingPeriodEnd);
	if (start === undefined || end === undefined || end <= start) return null;
	const limit = parseAmount(raw.monthlyLimit);
	const used = parseAmount(raw.used);
	if (limit === undefined || limit <= 0 || used === undefined) return null;
	return [
		{
			id: "xai:included:1mo",
			label: "Monthly",
			window: { id: "1mo", label: "Monthly", durationMs: end - start, resetsAt: end },
			remainingFraction: 1 - Math.min(used / limit, 1),
		},
	];
}

async function fetchBillingConfig(
	url: string,
	accessToken: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"X-XAI-Token-Auth": "xai-grok-cli",
		},
		redirect: "error",
		signal,
	});
	if (!response.ok) return undefined;
	const payload: unknown = await response.json();
	return isRecord(payload) && isRecord(payload.config) ? payload.config : undefined;
}

async function fetchXaiUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageLimit[]> {
	const credits = await fetchBillingConfig(`${BILLING_URL}?format=credits`, credential.accessToken, signal);
	const weekly = credits ? weeklyLimits(credits) : null;
	let monthly: UsageLimit[] | null = null;
	if (!weekly || credits?.isUnifiedBillingUser === true) {
		const config = await fetchBillingConfig(BILLING_URL, credential.accessToken, signal);
		monthly = config ? monthlyLimits(config) : null;
	}
	return [...(weekly ?? []), ...(monthly ?? [])];
}

export const xaiQuotaPlan: QuotaPlan = {
	id: "xai",
	matchProviders: ["xai"],
	fetch: fetchXaiUsage,
	format: formatUsageLimits,
};
