import type {
	ResolvedCredential,
	UsageAmount,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../types.ts";
import { createProviderQuotaPlan } from "./quota-adapter.ts";

const PROVIDER_ID = "xai";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BILLING_BASE_URL = "https://cli-chat-proxy.grok.com";
const BILLING_PATH = "/v1/billing";

interface BillingPeriod {
	start: string;
	end: string;
	type: string;
}

interface ProductUsage {
	product: string;
	usagePercent: number;
}

interface WeeklyBillingConfig {
	kind: "weekly";
	currentPeriod: BillingPeriod;
	creditUsagePercent: number;
	productUsage: ProductUsage[];
	onDemandCap?: number;
	onDemandUsed?: number;
}

interface MonthlyBillingConfig {
	kind: "monthly";
	periodStart: string;
	periodEnd: string;
	used: number;
	limit: number;
	onDemandCap?: number;
	onDemandUsed?: number;
}

type BillingConfig = WeeklyBillingConfig | MonthlyBillingConfig;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
};

function parseIsoMs(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercent(value: unknown): number | undefined {
	const percent = toNumber(value);
	return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}

function parseOnDemandAmount(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const amount = toNumber(value.val);
	return amount !== undefined && amount >= 0 ? amount : undefined;
}

function buildBillingUrl(format?: string): string {
	const url = new URL(BILLING_PATH, BILLING_BASE_URL);
	if (format) url.searchParams.set("format", format);
	return url.toString();
}

function billingHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"X-XAI-Token-Auth": "xai-grok-cli",
	};
}

function parseAccessTokenPayload(jwt: string): Record<string, unknown> | null {
	try {
		if (typeof jwt !== "string" || !jwt.includes(".")) return null;
		const parts = jwt.split(".");
		if (parts.length < 2 || !parts[1]) return null;
		const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
		const payload = JSON.parse(decoded) as unknown;
		return isRecord(payload) ? payload : null;
	} catch {
		return null;
	}
}

function extractSubject(jwt: string): string | undefined {
	const sub = parseAccessTokenPayload(jwt)?.sub;
	return typeof sub === "string" && sub.trim() ? sub.trim() : undefined;
}

interface OAuthIdentity {
	accountId?: string;
	email?: string;
}

async function fetchIdentity(accessToken: string, signal?: AbortSignal): Promise<OAuthIdentity | null> {
	try {
		const response = await fetch("https://auth.x.ai/oauth2/userinfo", {
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload)) return null;
		const sub = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
		const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : undefined;
		if (!sub && !email) return null;
		return { ...(sub ? { accountId: sub } : {}), ...(email ? { email: email.toLowerCase() } : {}) };
	} catch {
		return null;
	}
}

function buildPercentAmount(usagePercent: number): UsageAmount {
	const usedFraction = usagePercent / 100;
	return {
		used: usagePercent,
		limit: 100,
		remaining: 100 - usagePercent,
		usedFraction,
		remainingFraction: 1 - usedFraction,
		unit: "percent",
	};
}

function buildUsageStatus(usedFraction: number): UsageStatus {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function slugifyProduct(product: string): string {
	return product
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function buildPeriodWindow(period: BillingPeriod): UsageWindow {
	return { id: "1w", label: "Weekly", durationMs: WEEK_MS, resetsAt: parseIsoMs(period.end) };
}

function buildMonthlyWindow(periodStart: string, periodEnd: string): UsageWindow | undefined {
	const startMs = parseIsoMs(periodStart);
	const endMs = parseIsoMs(periodEnd);
	if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
	const durationMs = endMs - startMs;
	const approxDays = Math.max(1, Math.round(durationMs / DAY_MS));
	return {
		id: "1mo",
		label: approxDays === 30 || approxDays === 31 ? "Monthly" : `${approxDays}d`,
		durationMs,
		resetsAt: endMs,
	};
}

function parseWeeklyBillingConfig(raw: Record<string, unknown>): WeeklyBillingConfig | null {
	if (!isRecord(raw.currentPeriod)) return null;
	const start = typeof raw.currentPeriod.start === "string" ? parseIsoMs(raw.currentPeriod.start) : undefined;
	const end = typeof raw.currentPeriod.end === "string" ? parseIsoMs(raw.currentPeriod.end) : undefined;
	const type = typeof raw.currentPeriod.type === "string" ? raw.currentPeriod.type : "";
	if (start === undefined || end === undefined || end <= start || !type.toUpperCase().includes("WEEK")) return null;

	const creditUsagePercent = parsePercent(raw.creditUsagePercent);
	if (creditUsagePercent === undefined) return null;

	const productUsage: ProductUsage[] = [];
	if (raw.productUsage !== undefined) {
		if (!Array.isArray(raw.productUsage)) return null;
		for (const item of raw.productUsage) {
			if (!isRecord(item)) continue;
			const product = typeof item.product === "string" ? item.product.trim() : "";
			const usagePercent = parsePercent(item.usagePercent);
			if (!product || usagePercent === undefined) continue;
			productUsage.push({ product, usagePercent });
		}
	}

	return {
		kind: "weekly",
		currentPeriod: {
			start: raw.currentPeriod.start as string,
			end: raw.currentPeriod.end as string,
			type,
		},
		creditUsagePercent,
		productUsage,
		onDemandCap: parseOnDemandAmount(raw.onDemandCap),
		onDemandUsed: parseOnDemandAmount(raw.onDemandUsed),
	};
}

function parseMonthlyBillingConfig(raw: Record<string, unknown>): MonthlyBillingConfig | null {
	const periodStart = typeof raw.billingPeriodStart === "string" ? raw.billingPeriodStart : "";
	const periodEnd = typeof raw.billingPeriodEnd === "string" ? raw.billingPeriodEnd : "";
	const startMs = parseIsoMs(periodStart);
	const endMs = parseIsoMs(periodEnd);
	if (!periodStart || !periodEnd || startMs === undefined || endMs === undefined || endMs <= startMs) return null;

	const limit = parseOnDemandAmount(raw.monthlyLimit);
	const used = parseOnDemandAmount(raw.used);
	if (limit === undefined || limit <= 0 || used === undefined) return null;

	return {
		kind: "monthly",
		periodStart,
		periodEnd,
		used,
		limit,
		onDemandCap: parseOnDemandAmount(raw.onDemandCap),
		onDemandUsed: parseOnDemandAmount(raw.onDemandUsed),
	};
}

function buildOnDemandLimit(
	onDemandCap: number | undefined,
	onDemandUsed: number | undefined,
	_accountId: string | undefined,
): UsageLimit | undefined {
	if (onDemandCap === undefined || onDemandCap <= 0 || onDemandUsed === undefined) return undefined;
	const usedFraction = Math.min(onDemandUsed / onDemandCap, 1);
	return {
		id: `${PROVIDER_ID}:on-demand`,
		label: "On-demand",
		window: { id: "on-demand", label: "On-demand" },
		amount: {
			used: onDemandUsed,
			limit: onDemandCap,
			remaining: Math.max(0, onDemandCap - onDemandUsed),
			usedFraction,
			remainingFraction: 1 - usedFraction,
			unit: "unknown",
		},
		status: buildUsageStatus(usedFraction),
	};
}

function productLabel(product: string): string {
	if (product === "GrokBuild") return "Grok Build";
	if (product === "Api") return "API";
	return product;
}

function buildLimits(config: BillingConfig, accountId: string | undefined): UsageLimit[] {
	if (config.kind === "weekly") {
		const window = buildPeriodWindow(config.currentPeriod);
		const overall = buildPercentAmount(config.creditUsagePercent);
		const limits: UsageLimit[] = [
			{
				id: `${PROVIDER_ID}:credits:1w`,
				label: "SuperGrok Weekly Credits",
				window,
				amount: overall,
				status: buildUsageStatus(overall.usedFraction ?? 0),
			},
		];
		for (const item of config.productUsage) {
			const slug = slugifyProduct(item.product);
			if (!slug) continue;
			const amount = buildPercentAmount(item.usagePercent);
			limits.push({
				id: `${PROVIDER_ID}:product:${slug}:1w`,
				label: `${productLabel(item.product)} (Weekly)`,
				window,
				amount,
				status: buildUsageStatus(amount.usedFraction ?? 0),
			});
		}
		const onDemand = buildOnDemandLimit(config.onDemandCap, config.onDemandUsed, accountId);
		if (onDemand) limits.push(onDemand);
		return limits;
	}

	const window = buildMonthlyWindow(config.periodStart, config.periodEnd);
	if (!window) return [];
	const usedFraction = Math.min(config.used / config.limit, 1);
	const limits: UsageLimit[] = [
		{
			id: `${PROVIDER_ID}:included:1mo`,
			label: "SuperGrok Monthly Included",
			window,
			amount: {
				used: config.used,
				limit: config.limit,
				remaining: Math.max(0, config.limit - config.used),
				usedFraction,
				remainingFraction: 1 - usedFraction,
				unit: "unknown",
			},
			status: buildUsageStatus(usedFraction),
		},
	];
	const onDemand = buildOnDemandLimit(config.onDemandCap, config.onDemandUsed, accountId);
	if (onDemand) limits.push(onDemand);
	return limits;
}

async function fetchBillingPayload(url: string, accessToken: string, signal?: AbortSignal): Promise<unknown | null> {
	try {
		const response = await fetch(url, { headers: billingHeaders(accessToken), redirect: "error", signal });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

const xaiUsageProvider: UsageProvider = {
	id: PROVIDER_ID,
	async fetchUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageReport | null> {
		const accessToken = credential.accessToken?.trim();
		if (!accessToken) return null;

		let accountId = credential.accountId?.trim() || extractSubject(accessToken);
		let email = credential.email?.trim().toLowerCase();
		if (!email) {
			const identity = await fetchIdentity(accessToken, signal);
			email = identity?.email?.trim().toLowerCase() || undefined;
			accountId ??= identity?.accountId?.trim() || undefined;
		}

		const creditsUrl = buildBillingUrl("credits");
		const monthlyUrl = buildBillingUrl("");
		const creditsPayload = await fetchBillingPayload(creditsUrl, accessToken, signal);
		const weekly =
			creditsPayload && isRecord(creditsPayload) && isRecord(creditsPayload.config)
				? parseWeeklyBillingConfig(creditsPayload.config)
				: null;
		const creditsLooksUnified =
			!!creditsPayload &&
			isRecord(creditsPayload) &&
			isRecord(creditsPayload.config) &&
			creditsPayload.config.isUnifiedBillingUser === true;

		let monthlyPayload: unknown | null = null;
		let monthly: MonthlyBillingConfig | null = null;
		const shouldProbeMonthly = (!weekly || creditsLooksUnified) && monthlyUrl !== creditsUrl;
		if (shouldProbeMonthly) {
			monthlyPayload = await fetchBillingPayload(monthlyUrl, accessToken, signal);
			monthly =
				monthlyPayload && isRecord(monthlyPayload) && isRecord(monthlyPayload.config)
					? parseMonthlyBillingConfig(monthlyPayload.config)
					: null;
		}

		if (!weekly && !monthly) return null;

		const limits: UsageLimit[] = [];
		if (weekly) limits.push(...buildLimits(weekly, accountId));
		if (monthly) limits.push(...buildLimits(monthly, accountId));
		const seen = new Set<string>();
		const deduped = limits.filter((limit) => {
			if (seen.has(limit.id)) return false;
			seen.add(limit.id);
			return true;
		});
		if (deduped.length === 0) return null;

		const billingKind = weekly && monthly ? "unified" : weekly ? "weekly" : "monthly";
		const endpoint = weekly && monthly ? `${creditsUrl} + ${monthlyUrl}` : weekly ? creditsUrl : monthlyUrl;
		const metadata: Record<string, unknown> = { endpoint, source: BILLING_BASE_URL, billingKind };
		if (accountId) metadata.accountId = accountId;
		if (email) metadata.email = email;

		return { provider: PROVIDER_ID, fetchedAt: Date.now(), limits: deduped, metadata };
	},
};

export const xaiQuotaPlan = createProviderQuotaPlan({
	id: "xai",
	name: "xAI",
	matchProviders: ["xai"],
	apiKeyEnv: "XAI_API_KEY",
	provider: xaiUsageProvider,
});
