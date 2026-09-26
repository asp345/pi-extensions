import { isRecord, toNumber } from "../../shared/json.ts";
import type { QuotaPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit, UsageWindow } from "../types.ts";
import { formatUsageLimits } from "./quota-adapter.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOUR_WINDOW: UsageWindow = { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 };
const SEVEN_DAY_WINDOW: UsageWindow = { id: "7d", label: "7 Day", durationMs: 7 * 24 * 60 * 60 * 1000 };

const CLAUDE_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";
const CLAUDE_VERSION = "2.1.220";

interface ParsedBucket {
	utilization?: number;
	resetsAt?: number;
}

interface ParsedApiLimitEntry {
	kind: string;
	bucket: ParsedBucket;
	displayName?: string;
}

function parseIsoTime(value: unknown): number | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBucket(bucket: unknown): ParsedBucket | undefined {
	if (!isRecord(bucket)) return undefined;
	const utilization = toNumber(bucket.utilization);
	const resetsAt = parseIsoTime(bucket.resets_at);
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
	for (const entry of raw) {
		if (!isRecord(entry) || typeof entry.kind !== "string") continue;
		const utilization = toNumber(entry.percent);
		const resetsAt = parseIsoTime(entry.resets_at);
		if (utilization === undefined && resetsAt === undefined) continue;
		entries.push({
			kind: entry.kind,
			bucket: { utilization, resetsAt },
			displayName: apiLimitDisplayName(entry.scope),
		});
	}
	return entries;
}

function buildUsageLimit(
	id: string,
	label: string,
	window: UsageWindow,
	bucket: ParsedBucket | undefined,
): UsageLimit | null {
	if (bucket?.utilization === undefined) return null;
	return {
		id,
		label,
		window: { ...window, resetsAt: bucket.resetsAt },
		remainingFraction: 1 - Math.min(Math.max(bucket.utilization, 0), 100) / 100,
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
		const limit = buildUsageLimit(
			`anthropic:7d:${slug}`,
			`Claude 7 Day (${entry.displayName})`,
			SEVEN_DAY_WINDOW,
			entry.bucket,
		);
		if (limit) limits.push(limit);
	}
	return limits;
}

async function fetchAnthropicUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageLimit[]> {
	const response = await fetch(USAGE_URL, {
		headers: {
			accept: "application/json, text/plain, */*",
			"anthropic-beta": CLAUDE_BETA,
			"content-type": "application/json",
			"user-agent": `claude-cli/${CLAUDE_VERSION} (external, cli)`,
			authorization: `Bearer ${credential.accessToken}`,
		},
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data: unknown = await response.json();
	if (!isRecord(data)) return [];

	const apiLimitEntries = parseApiLimitEntries(data.limits);
	const fiveHour = parseBucket(data.five_hour) ?? apiLimitEntries.find((e) => e.kind === "session")?.bucket;
	const sevenDay = parseBucket(data.seven_day) ?? apiLimitEntries.find((e) => e.kind === "weekly_all")?.bucket;
	return [
		buildUsageLimit("anthropic:5h", "Claude 5 Hour", FIVE_HOUR_WINDOW, fiveHour),
		buildUsageLimit("anthropic:7d", "Claude 7 Day", SEVEN_DAY_WINDOW, sevenDay),
		buildUsageLimit("anthropic:7d:opus", "Claude 7 Day (Opus)", SEVEN_DAY_WINDOW, parseBucket(data.seven_day_opus)),
		buildUsageLimit(
			"anthropic:7d:sonnet",
			"Claude 7 Day (Sonnet)",
			SEVEN_DAY_WINDOW,
			parseBucket(data.seven_day_sonnet),
		),
		...buildScopedWeeklyUsageLimits(apiLimitEntries),
	].filter((limit): limit is UsageLimit => limit !== null);
}

export const anthropicQuotaPlan: QuotaPlan = {
	id: "anthropic",
	matchProviders: ["anthropic"],
	fetch: fetchAnthropicUsage,
	format: formatUsageLimits,
};
