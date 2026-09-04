/**
 * Usage report types, adapted from the oh-my-pi usage schema.
 * Credential ranking and rate-limit-header parsing are intentionally omitted;
 * this extension only fetches on-demand usage reports.
 */

export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "unknown";
export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface UsageWindow {
	id: string;
	label: string;
	durationMs?: number;
	resetsAt?: number;
}

export interface UsageAmount {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	remainingFraction?: number;
	unit: UsageUnit;
}

export interface UsageLimit {
	id: string;
	label: string;
	window?: UsageWindow;
	amount: UsageAmount;
	status?: UsageStatus;
	notes?: string[];
}

export interface UsageReport {
	provider: string;
	fetchedAt: number;
	limits: UsageLimit[];
	metadata?: Record<string, unknown>;
}

export interface ResolvedCredential {
	accessToken: string;
	accountId?: string;
	projectId?: string;
	email?: string;
}

export interface UsageProvider {
	id: string;
	fetchUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageReport | null>;
}

/** Runtime state shared between the footer renderer and the token stats runtime. */
export interface SharedState {
	/** Whether the session is active. Set by session_start and session_shutdown. */
	sessionActive: boolean;
	/** Footer render callback, cleared when the footer or session closes. */
	requestRender: (() => void) | null;
}

export function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}
