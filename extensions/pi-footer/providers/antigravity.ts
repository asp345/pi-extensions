import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_USER_AGENT } from "@asp345/pi-antigravity-auth/constants.ts";
import type { QuotaPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit } from "../types.ts";
import { formatUsageLimits } from "./quota-adapter.ts";

const WINDOWS: Record<string, { label: string; durationMs: number }> = {
	"5h": { label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
	weekly: { label: "Weekly", durationMs: 7 * 24 * 60 * 60 * 1000 },
};

interface QuotaBucket {
	bucketId?: string;
	window?: string;
	resetTime?: string;
	remainingFraction?: number;
}

interface QuotaSummary {
	groups?: Array<{ buckets?: QuotaBucket[] }>;
}

function usageLimit(bucket: QuotaBucket): UsageLimit[] {
	const window = bucket.window ? WINDOWS[bucket.window] : undefined;
	if (!bucket.window || !window) return [];
	const resetsAt = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
	return [
		{
			id: `antigravity:${bucket.bucketId ?? bucket.window}`,
			label: "Usage",
			window: {
				id: bucket.window,
				label: window.label,
				durationMs: window.durationMs,
				resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
			},
			remainingFraction: bucket.remainingFraction ?? 0,
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
	return (summary.groups ?? []).flatMap((group) => group.buckets ?? []).flatMap(usageLimit);
}

function formatModelGroup(data: unknown, modelId?: string) {
	if (!modelId) return formatUsageLimits(data);
	const gemini = modelId.startsWith("gemini-");
	return formatUsageLimits(
		(data as UsageLimit[]).filter((limit) => limit.id.startsWith("antigravity:gemini-") === gemini),
	);
}

export const antigravityQuotaPlan: QuotaPlan = {
	id: "antigravity",
	matchProviders: ["google-antigravity", "antigravity"],
	fetch: fetchAntigravityUsage,
	format: formatModelGroup,
};
