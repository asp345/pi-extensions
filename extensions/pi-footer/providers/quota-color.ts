const QUOTA_ERROR_PERCENT = 10;
const QUOTA_WARN_PERCENT = 20;

/**
 * Shared quota color ladder: err when any remaining window is below the error
 * threshold, warn below the warning threshold, ok otherwise. Null values are
 * ignored; all-null yields ok.
 */
export function quotaColor(...remainings: Array<number | null>): "ok" | "warn" | "err" {
	const values = remainings.filter((value): value is number => value !== null);
	const minimum = Math.min(...values);
	if (!Number.isFinite(minimum)) return "ok";
	if (minimum < QUOTA_ERROR_PERCENT) return "err";
	if (minimum < QUOTA_WARN_PERCENT) return "warn";
	return "ok";
}
