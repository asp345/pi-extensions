import { Buffer } from "node:buffer";
import type { ResolvedCredential, UsageAmount, UsageLimit, UsageProvider, UsageReport, UsageWindow } from "../types.ts";
import { createProviderQuotaPlan } from "./quota-adapter.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_USAGE_PATH = "wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

interface ParsedUsageWindow {
	usedPercent?: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
}

interface ParsedUsage {
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: ParsedUsageWindow;
	secondary?: ParsedUsageWindow;
}

interface JwtPayload {
	[JWT_AUTH_CLAIM]?: { chatgpt_account_id?: string };
	[JWT_PROFILE_CLAIM]?: { email?: string };
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

const toBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

function base64UrlDecode(input: string): string {
	const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLen = (4 - (base64.length % 4)) % 4;
	return Buffer.from(base64 + "=".repeat(padLen), "base64").toString("utf8");
}

function parseJwt(token: string): JwtPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const payload = parts[1];
	if (!payload) return null;
	try {
		return JSON.parse(base64UrlDecode(payload)) as JwtPayload;
	} catch {
		return null;
	}
}

function normalizeEmail(email: string | undefined): string | undefined {
	const normalized = email?.trim().toLowerCase();
	return normalized || undefined;
}

function extractAccountId(token: string | undefined): string | undefined {
	if (!token) return undefined;
	return parseJwt(token)?.[JWT_AUTH_CLAIM]?.chatgpt_account_id ?? undefined;
}

function extractEmail(token: string | undefined): string | undefined {
	if (!token) return undefined;
	return normalizeEmail(parseJwt(token)?.[JWT_PROFILE_CLAIM]?.email);
}

function parseUsageWindow(payload: unknown): ParsedUsageWindow | undefined {
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
	return { usedPercent, limitWindowSeconds, resetAfterSeconds, resetAt };
}

function parseUsagePayload(payload: unknown): ParsedUsage | null {
	if (!isRecord(payload)) return null;
	const planType = typeof payload.plan_type === "string" ? payload.plan_type : undefined;
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
	if (!rateLimit) return null;
	const primary = parseUsageWindow(rateLimit.primary_window);
	const secondary = parseUsageWindow(rateLimit.secondary_window);
	const allowed = toBoolean(rateLimit.allowed);
	const limitReached = toBoolean(rateLimit.limit_reached);
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) return null;
	return { planType, allowed, limitReached, primary, secondary };
}

function resolveResetTime(window: ParsedUsageWindow, nowMs: number): number | undefined {
	const resetAt = window.resetAt;
	if (resetAt !== undefined) {
		const resetAtMs = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
		if (Number.isFinite(resetAtMs)) return resetAtMs;
	}
	if (window.resetAfterSeconds !== undefined) return nowMs + window.resetAfterSeconds * 1000;
	return undefined;
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

function buildUsageWindow(window: ParsedUsageWindow, key: string, nowMs: number): UsageWindow {
	const resetsAt = resolveResetTime(window, nowMs);
	if (window.limitWindowSeconds !== undefined) {
		const { id, label } = buildWindowLabel(window.limitWindowSeconds);
		const durationMs = window.limitWindowSeconds * 1000;
		return { id, label, durationMs, ...(resetsAt !== undefined ? { resetsAt } : {}) };
	}
	const fallbackLabel = key === "primary" ? "Primary window" : "Secondary window";
	return { id: key, label: fallbackLabel, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function buildUsageAmount(window: ParsedUsageWindow): UsageAmount {
	const usedPercent = window.usedPercent;
	if (usedPercent === undefined) return { unit: "percent" };
	const clamped = Math.min(Math.max(usedPercent, 0), 100);
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

function buildUsageStatus(usedFraction: number | undefined, limitReached?: boolean): UsageLimit["status"] {
	if (limitReached) return "exhausted";
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function buildUsageLimit(args: {
	key: "primary" | "secondary";
	window: ParsedUsageWindow;
	accountId?: string;
	planType?: string;
	nowMs: number;
	limitReached?: boolean;
}): UsageLimit {
	const usageWindow = buildUsageWindow(args.window, args.key, args.nowMs);
	const amount = buildUsageAmount(args.window);
	return {
		id: `openai-codex:${args.key}`,
		label: usageWindow.label,
		window: usageWindow,
		amount,
		status: buildUsageStatus(amount.usedFraction, args.limitReached),
	};
}

function normalizeCodexBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return CODEX_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return CODEX_BASE_URL;
	}
	const host = parsed.host.toLowerCase();
	if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_BASE_URL;
	return `${parsed.origin}/backend-api`;
}

const openaiCodexUsageProvider: UsageProvider = {
	id: "openai-codex",
	async fetchUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageReport | null> {
		const accessToken = credential.accessToken;
		if (!accessToken) return null;
		const nowMs = Date.now();

		const baseUrl = normalizeCodexBaseUrl();
		const accountId = credential.accountId ?? extractAccountId(accessToken);
		const email = normalizeEmail(credential.email ?? extractEmail(accessToken));

		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "OpenCode-Status-Plugin/1.0",
		};
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;

		const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		const url = `${normalized}${CODEX_USAGE_PATH}`;
		let payload: unknown;
		try {
			const response = await fetch(url, { headers, signal });
			if (!response.ok) return null;
			payload = await response.json();
		} catch {
			return null;
		}

		const parsed = parseUsagePayload(payload);
		const planType =
			parsed?.planType ?? (isRecord(payload) && typeof payload.plan_type === "string" ? payload.plan_type : undefined);

		const limits: UsageLimit[] = [];
		let limitReached: boolean | undefined;
		if (parsed?.primary) {
			limitReached = parsed.limitReached;
			limits.push(
				buildUsageLimit({ key: "primary", window: parsed.primary, accountId, planType, nowMs, limitReached }),
			);
		}
		if (parsed?.secondary) {
			limits.push(
				buildUsageLimit({ key: "secondary", window: parsed.secondary, accountId, planType, nowMs, limitReached }),
			);
		}

		if (limits.length === 0) return null;
		const metadata: Record<string, unknown> = { endpoint: url };
		if (planType) metadata.planType = planType;
		if (email) metadata.email = email;
		if (accountId) metadata.accountId = accountId;
		metadata.allowed = parsed?.allowed;
		metadata.limitReached = limitReached ?? parsed?.limitReached;
		return { provider: "openai-codex", fetchedAt: nowMs, limits, metadata };
	},
};

export const openaiCodexQuotaPlan = createProviderQuotaPlan({
	id: "openai-codex",
	name: "OpenAI Codex",
	matchProviders: ["openai-codex"],
	apiKeyEnv: "OPENAI_API_KEY",
	provider: openaiCodexUsageProvider,
});
