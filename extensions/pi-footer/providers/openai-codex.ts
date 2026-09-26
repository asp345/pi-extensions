import { Buffer } from "node:buffer";
import type { QuotaPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit, UsageWindow } from "../types.ts";
import { formatUsageLimits } from "./quota-adapter.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

interface JwtPayload {
	[JWT_AUTH_CLAIM]?: { chatgpt_account_id?: string };
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

function extractAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtPayload;
		return payload[JWT_AUTH_CLAIM]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function formatWindowLabel(value: number, unit: "hour" | "day"): string {
	const rounded = Math.round(value);
	const suffix = rounded === 1 ? unit : `${unit}s`;
	return `${rounded} ${suffix}`;
}

function buildWindowLabel(seconds: number): { id: string; label: string } {
	const daySeconds = 86_400;
	if (seconds >= daySeconds) {
		const days = Math.round(seconds / daySeconds);
		return { id: `${days}d`, label: formatWindowLabel(days, "day") };
	}
	const hours = Math.max(1, Math.round(seconds / 3600));
	return { id: `${hours}h`, label: formatWindowLabel(hours, "hour") };
}

function buildUsageLimit(key: "primary" | "secondary", payload: unknown, nowMs: number): UsageLimit | undefined {
	if (!isRecord(payload)) return undefined;
	const usedPercent = toNumber(payload.used_percent);
	const limitWindowSeconds = toNumber(payload.limit_window_seconds);
	const resetAfterSeconds = toNumber(payload.reset_after_seconds);
	const resetAt = toNumber(payload.reset_at);
	if (
		usedPercent === undefined &&
		limitWindowSeconds === undefined &&
		resetAfterSeconds === undefined &&
		resetAt === undefined
	) {
		return undefined;
	}
	const resetsAt =
		resetAt !== undefined
			? resetAt > 1_000_000_000_000
				? resetAt
				: resetAt * 1000
			: resetAfterSeconds !== undefined
				? nowMs + resetAfterSeconds * 1000
				: undefined;
	const window: UsageWindow =
		limitWindowSeconds !== undefined
			? { ...buildWindowLabel(limitWindowSeconds), durationMs: limitWindowSeconds * 1000, resetsAt }
			: { id: key, label: key === "primary" ? "Primary window" : "Secondary window", resetsAt };
	return {
		id: `openai-codex:${key}`,
		label: window.label,
		window,
		remainingFraction: usedPercent === undefined ? undefined : 1 - Math.min(Math.max(usedPercent, 0), 100) / 100,
	};
}

async function fetchCodexUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageLimit[]> {
	const accountId = credential.accountId ?? extractAccountId(credential.accessToken);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.accessToken}`,
		"User-Agent": "OpenCode-Status-Plugin/1.0",
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const response = await fetch(CODEX_USAGE_URL, { headers, signal });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const payload: unknown = await response.json();
	const rateLimit = isRecord(payload) && isRecord(payload.rate_limit) ? payload.rate_limit : {};
	const nowMs = Date.now();
	return [
		buildUsageLimit("primary", rateLimit.primary_window, nowMs),
		buildUsageLimit("secondary", rateLimit.secondary_window, nowMs),
	].filter((limit): limit is UsageLimit => limit !== undefined);
}

export const openaiCodexQuotaPlan: QuotaPlan = {
	id: "openai-codex",
	matchProviders: ["openai-codex"],
	fetch: fetchCodexUsage,
	format: formatUsageLimits,
};
