import type { ResolvedCredential, UsageAmount, UsageLimit, UsageProvider, UsageReport, UsageWindow } from "../types.ts";
import { createProviderQuotaPlan } from "./quota-adapter.ts";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/api/oauth";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const CLAUDE_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";
const CLAUDE_VERSION = "2.1.220";

interface ClaudeUsageBucket {
	utilization?: number;
	resets_at?: string;
}

interface ClaudeExtraUsage {
	is_enabled?: boolean;
	monthly_limit?: number | null;
	used_credits?: number;
	decimal_places?: number;
	currency?: string;
}

interface ClaudeMoneyAmount {
	amount_minor?: number;
	currency?: string;
	exponent?: number;
}

interface ClaudeSpend {
	used?: ClaudeMoneyAmount | null;
	limit?: ClaudeMoneyAmount | null;
	enabled?: boolean;
}

interface ClaudeApiLimitEntry {
	kind?: string;
	percent?: unknown;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string | null } | null } | null;
	is_active?: boolean;
}

interface ClaudeUsageResponse {
	five_hour?: ClaudeUsageBucket | null;
	seven_day?: ClaudeUsageBucket | null;
	seven_day_opus?: ClaudeUsageBucket | null;
	seven_day_sonnet?: ClaudeUsageBucket | null;
	limits?: unknown;
	extra_usage?: ClaudeExtraUsage | null;
	spend?: ClaudeSpend | null;
}

interface ParsedBucket {
	utilization?: number;
	resetsAt?: number;
}

interface ParsedApiLimitEntry {
	kind: string;
	bucket: ParsedBucket;
	displayName?: string;
}

interface ParsedClaudeExtraUsage {
	used: number;
	limit?: number;
}

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

function parseIsoTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBucket(bucket: unknown): ParsedBucket | undefined {
	if (!isRecord(bucket)) return undefined;
	const utilization = toNumber(bucket.utilization);
	const resetsAt = parseIsoTime(typeof bucket.resets_at === "string" ? bucket.resets_at : undefined);
	if (utilization === undefined && resetsAt === undefined) return undefined;
	return { utilization, resetsAt };
}

function apiLimitDisplayName(scope: unknown): string | undefined {
	if (!isRecord(scope) || !isRecord(scope.model)) return undefined;
	const name = scope.model.display_name;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function parseApiLimitEntries(raw: unknown): ParsedApiLimitEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: ParsedApiLimitEntry[] = [];
	for (const rawEntry of raw) {
		if (!isRecord(rawEntry)) continue;
		const entry = rawEntry as ClaudeApiLimitEntry;
		if (typeof entry.kind !== "string") continue;
		const utilization = toNumber(entry.percent);
		const resetsAt = parseIsoTime(typeof entry.resets_at === "string" ? entry.resets_at : undefined);
		if (utilization === undefined && resetsAt === undefined) continue;
		const displayName = apiLimitDisplayName(entry.scope);
		entries.push({
			kind: entry.kind,
			bucket: { utilization, resetsAt },
			...(displayName ? { displayName } : {}),
		});
	}
	return entries;
}

function buildUsageAmount(utilization: number | undefined): UsageAmount | undefined {
	if (utilization === undefined) return undefined;
	const clamped = Math.min(Math.max(utilization, 0), 100);
	const usedFraction = clamped / 100;
	return {
		used: clamped,
		limit: 100,
		remaining: Math.max(0, 100 - clamped),
		usedFraction,
		remainingFraction: Math.max(0, 1 - usedFraction),
		unit: "percent",
	};
}

function buildUsageStatus(usedFraction: number | undefined): UsageLimit["status"] | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function parseDollarAmount(
	amountMinor: unknown,
	exponent: unknown,
	currency: unknown,
	currencyRequired: boolean,
): number | undefined {
	if (
		typeof amountMinor !== "number" ||
		!Number.isSafeInteger(amountMinor) ||
		amountMinor < 0 ||
		typeof exponent !== "number" ||
		!Number.isSafeInteger(exponent) ||
		exponent < 0
	) {
		return undefined;
	}
	if (currency === undefined) {
		if (currencyRequired) return undefined;
	} else if (typeof currency !== "string" || currency.toUpperCase() !== "USD") {
		return undefined;
	}
	const divisor = 10 ** exponent;
	if (!Number.isFinite(divisor)) return undefined;
	const dollars = amountMinor / divisor;
	return Number.isFinite(dollars) ? dollars : undefined;
}

function parseSpendExtraUsage(value: unknown): ParsedClaudeExtraUsage | null {
	if (!isRecord(value) || value.enabled !== true || !Object.hasOwn(value, "limit") || !isRecord(value.used)) {
		return null;
	}
	const used = parseDollarAmount(value.used.amount_minor, value.used.exponent, value.used.currency, true);
	if (used === undefined) return null;
	if (value.limit === null) return { used };
	if (!isRecord(value.limit)) return null;
	const limit = parseDollarAmount(value.limit.amount_minor, value.limit.exponent, value.limit.currency, true);
	return limit === undefined || limit <= 0 ? null : { used, limit };
}

function parseLegacyExtraUsage(value: unknown): ParsedClaudeExtraUsage | null {
	if (!isRecord(value) || value.is_enabled !== true || !Object.hasOwn(value, "monthly_limit")) return null;
	const decimalPlaces = value.decimal_places === undefined ? 2 : value.decimal_places;
	const used = parseDollarAmount(value.used_credits, decimalPlaces, value.currency, false);
	if (used === undefined) return null;
	if (value.monthly_limit === null || value.monthly_limit === undefined) return { used };
	const limit = parseDollarAmount(value.monthly_limit, decimalPlaces, value.currency, false);
	return limit === undefined || limit <= 0 ? null : { used, limit };
}

function buildExtraUsageLimit(payload: ClaudeUsageResponse): UsageLimit | null {
	const parsed =
		payload.spend === null || payload.spend === undefined
			? parseLegacyExtraUsage(payload.extra_usage)
			: parseSpendExtraUsage(payload.spend);
	if (!parsed) return null;
	const amount: UsageAmount = { used: parsed.used, unit: "usd" };
	if (parsed.limit !== undefined) {
		const remaining = Math.max(0, parsed.limit - parsed.used);
		const usedFraction = parsed.used / parsed.limit;
		amount.limit = parsed.limit;
		amount.remaining = remaining;
		amount.usedFraction = usedFraction;
		amount.remainingFraction = remaining / parsed.limit;
	}
	const status =
		parsed.limit === undefined
			? undefined
			: parsed.used >= parsed.limit
				? "exhausted"
				: (buildUsageStatus(amount.usedFraction) ?? "ok");
	return {
		id: "anthropic:extra",
		label: "Claude Extra Usage",
		window: { id: "extra", label: "Extra" },
		amount,
		...(status !== undefined ? { status } : {}),
	};
}

function buildUsageLimit(args: {
	id: string;
	label: string;
	windowId: string;
	windowLabel: string;
	durationMs: number;
	bucket: ParsedBucket | undefined;
	tier?: string;
}): UsageLimit | null {
	if (!args.bucket) return null;
	const amount = buildUsageAmount(args.bucket.utilization);
	if (!amount) return null;
	const window: UsageWindow = {
		id: args.windowId,
		label: args.windowLabel,
		durationMs: args.durationMs,
		...(args.bucket.resetsAt !== undefined ? { resetsAt: args.bucket.resetsAt } : {}),
	};
	return {
		id: args.id,
		label: args.label,
		window,
		amount,
		status: buildUsageStatus(amount.usedFraction),
	};
}

function slugify(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function buildScopedWeeklyUsageLimits(entries: readonly ParsedApiLimitEntry[]): UsageLimit[] {
	const seen = new Set<string>();
	const limits: UsageLimit[] = [];
	for (const entry of entries) {
		if (entry.kind !== "weekly_scoped" || !entry.displayName) continue;
		const slug = slugify(entry.displayName);
		if (!slug || seen.has(slug)) continue;
		seen.add(slug);
		const limit = buildUsageLimit({
			id: `anthropic:7d:${slug}`,
			label: `Claude 7 Day (${entry.displayName})`,
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: SEVEN_DAYS_MS,
			bucket: entry.bucket,
			tier: slug,
		});
		if (limit) limits.push(limit);
	}
	return limits;
}

const anthropicUsageProvider: UsageProvider = {
	id: "anthropic",
	async fetchUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageReport | null> {
		const baseUrl = DEFAULT_ENDPOINT;
		const url = `${baseUrl}/usage`;
		const headers: Record<string, string> = {
			accept: "application/json, text/plain, */*",
			"anthropic-beta": CLAUDE_BETA,
			"content-type": "application/json",
			"user-agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
			authorization: `Bearer ${credential.accessToken}`,
		};

		const response = await fetch(url, { headers, signal });
		if (!response.ok) return null;
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload)) return null;

		const data = payload as ClaudeUsageResponse;
		const apiLimitEntries = parseApiLimitEntries(data.limits);
		const fiveHour = parseBucket(data.five_hour) ?? apiLimitEntries.find((e) => e.kind === "session")?.bucket;
		const sevenDay = parseBucket(data.seven_day) ?? apiLimitEntries.find((e) => e.kind === "weekly_all")?.bucket;
		const sevenDayOpus = parseBucket(data.seven_day_opus);
		const sevenDaySonnet = parseBucket(data.seven_day_sonnet);

		const limits: UsageLimit[] = [
			buildUsageLimit({
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				windowId: "5h",
				windowLabel: "5 Hour",
				durationMs: FIVE_HOURS_MS,
				bucket: fiveHour,
			}),
			buildUsageLimit({
				id: "anthropic:7d",
				label: "Claude 7 Day",
				windowId: "7d",
				windowLabel: "7 Day",
				durationMs: SEVEN_DAYS_MS,
				bucket: sevenDay,
			}),
			buildUsageLimit({
				id: "anthropic:7d:opus",
				label: "Claude 7 Day (Opus)",
				windowId: "7d",
				windowLabel: "7 Day",
				durationMs: SEVEN_DAYS_MS,
				bucket: sevenDayOpus,
			}),
			buildUsageLimit({
				id: "anthropic:7d:sonnet",
				label: "Claude 7 Day (Sonnet)",
				windowId: "7d",
				windowLabel: "7 Day",
				durationMs: SEVEN_DAYS_MS,
				bucket: sevenDaySonnet,
			}),
			...buildScopedWeeklyUsageLimits(apiLimitEntries),
			buildExtraUsageLimit(data),
		].filter((limit): limit is UsageLimit => limit !== null);

		if (limits.length === 0) return null;
		return { provider: "anthropic", fetchedAt: Date.now(), limits, metadata: { endpoint: url } };
	},
};

export const anthropicQuotaPlan = createProviderQuotaPlan({
	id: "anthropic",
	name: "Claude",
	matchProviders: ["anthropic"],
	apiKeyEnv: "ANTHROPIC_API_KEY",
	provider: anthropicUsageProvider,
});
