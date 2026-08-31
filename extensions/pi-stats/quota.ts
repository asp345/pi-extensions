import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TeamCredential {
	organization: string;
	project: string;
}

export interface QuotaFetchExtra {
	team?: TeamCredential | null;
}

export interface QuotaDisplay {
	modelPrefix: string;
	display: string;
	color: "ok" | "warn" | "err";
}

export interface TokenPlan {
	id: string;
	name: string;
	matchProviders: string[];
	apiKeyEnv: string;
	baseUrl: string;
	quotaPath: string;
	authHeader: (key: string) => Record<string, string>;
	fetchQuota: (plan: TokenPlan, key: string, extra?: QuotaFetchExtra) => Promise<unknown>;
	fetchQuotaWithContext?: (ctx: ExtensionContext) => Promise<unknown>;
	format: (data: unknown) => QuotaDisplay;
}

export function formatDuration(ms: number): string {
	if (ms <= 0) return "";
	if (ms >= 24 * 60 * 60 * 1000) {
		const days = Math.floor(ms / (24 * 60 * 60 * 1000));
		const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
		if (days >= 7) return `${Math.floor(days / 7)}w ${days % 7}d`;
		return `${days}d ${hours}h`;
	}
	const hours = Math.floor(ms / (60 * 60 * 1000));
	const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatTokenPlanDisplay(
	fiveHourRemaining: number,
	weeklyRemaining: number,
	nearestResetMs?: number | null,
): string {
	let display = `5h: ${Math.round(fiveHourRemaining)}% W: ${Math.round(weeklyRemaining)}%`;
	if (!nearestResetMs) return display;
	const remaining = nearestResetMs - Date.now();
	if (remaining > 0 && remaining < 30 * 24 * 60 * 60 * 1000) display += ` ⏱ ${formatDuration(remaining)}`;
	return display;
}
