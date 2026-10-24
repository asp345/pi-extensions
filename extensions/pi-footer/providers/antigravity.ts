import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_USER_AGENT } from "@asp345/pi-antigravity-auth/constants.ts";
import type { QuotaDisplay, QuotaPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit } from "../types.ts";
import { formatUsageLimits } from "./quota-adapter.ts";

const WINDOWS: Record<string, { label: string; durationMs: number }> = {
	"5h": { label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
	weekly: { label: "Weekly", durationMs: 7 * 24 * 60 * 60 * 1000 },
};

const LIMIT_PREFIX = "antigravity:";

type QuotaPool = "argon" | "gemini" | "third-party";

interface QuotaBucket {
	bucketId?: string;
	window?: string;
	resetTime?: string;
	remainingFraction?: number;
}

interface QuotaGroup {
	displayName?: string;
	description?: string;
	buckets?: QuotaBucket[];
}

interface QuotaSummary {
	groups?: QuotaGroup[];
}

function quotaPool(group: QuotaGroup, bucket: QuotaBucket): QuotaPool | undefined {
	const text = `${group.displayName ?? ""} ${group.description ?? ""} ${bucket.bucketId ?? ""}`.toLowerCase();
	if (text.includes("argon")) return "argon";
	if (text.includes("gemini")) return "gemini";
	if (text.includes("claude") || text.includes("gpt") || text.includes("3p")) return "third-party";
	return undefined;
}

function modelPool(modelId: string): QuotaPool {
	if (modelId.includes("argon")) return "argon";
	if (modelId.startsWith("gemini-")) return "gemini";
	return "third-party";
}

function poolAppliesToModel(pool: QuotaPool | undefined, modelId?: string): boolean {
	if (!pool || !modelId) return true;
	const model = modelPool(modelId);
	return model === "argon" ? pool !== "third-party" : pool === model;
}

function limitPool(limit: UsageLimit): QuotaPool | undefined {
	const pool = limit.id.slice(LIMIT_PREFIX.length).split(":")[0];
	return pool === "argon" || pool === "gemini" || pool === "third-party" ? pool : undefined;
}

function usageLimit(pool: QuotaPool | undefined, bucket: QuotaBucket): UsageLimit[] {
	const window = bucket.window ? WINDOWS[bucket.window] : undefined;
	const fraction = bucket.remainingFraction;
	if (!bucket.window || !window || typeof fraction !== "number" || !Number.isFinite(fraction)) return [];
	const resetsAt = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
	return [
		{
			id: `${LIMIT_PREFIX}${pool ?? "shared"}:${bucket.bucketId ?? bucket.window}`,
			label: "Usage",
			window: {
				id: bucket.window,
				label: window.label,
				durationMs: window.durationMs,
				resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
			},
			remainingFraction: fraction,
		},
	];
}

async function fetchAntigravityUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageLimit[]> {
	if (!credential.projectId) throw new Error("Missing Antigravity project id");
	const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credential.accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": ANTIGRAVITY_USER_AGENT,
		},
		body: JSON.stringify({ project: credential.projectId }),
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const summary = (await response.json()) as QuotaSummary;
	return (summary.groups ?? []).flatMap((group) =>
		(group.buckets ?? []).flatMap((bucket) => usageLimit(quotaPool(group, bucket), bucket)),
	);
}

function formatAntigravityUsage(data: unknown, modelId?: string): QuotaDisplay | null {
	const limits = (data as UsageLimit[]).filter((limit) => poolAppliesToModel(limitPool(limit), modelId));
	return formatUsageLimits(limits);
}

export const antigravityQuotaPlan: QuotaPlan = {
	id: "antigravity",
	matchProviders: ["google-antigravity", "antigravity"],
	fetch: fetchAntigravityUsage,
	format: formatAntigravityUsage,
};
