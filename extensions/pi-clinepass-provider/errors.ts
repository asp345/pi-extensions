/**
 * Cline error classification — maps provider error messages to
 * user-friendly, actionable messages.
 *
 * @module cline-errors
 */

/** Error types returned by the Cline API. */
export type ClineErrorType = "not_subscribed" | "auth_expired" | "rate_limited" | "unknown";

/**
 * Check if a lowercased string matches any of the given patterns.
 */
function matchesAny(text: string, patterns: string[]): boolean {
	return patterns.some((p) => text.includes(p));
}

/**
 * User-friendly error messages for Cline-specific failures.
 */
export const CLINE_ERROR_MESSAGES: Record<ClineErrorType, string> = {
	not_subscribed:
		"Cline access is unavailable for this account. Visit app.cline.bot or run `pi /login` to re-authenticate.",
	auth_expired: "Cline authentication expired. Run `pi /login` to refresh your credentials.",
	rate_limited: "Cline rate limit reached. Wait a moment and try again, or upgrade your plan at app.cline.bot.",
	unknown: "Cline request failed. Check your account at app.cline.bot or run `pi /login`.",
};

/**
 * Classify a Cline API error message into a specific error type.
 */
export function classifyClineError(errorMessage: string): {
	type: ClineErrorType;
	message: string;
} {
	const lower = errorMessage.toLowerCase();

	if (matchesAny(lower, ["403", "forbidden", "subscription required", "not subscribed"])) {
		return { type: "not_subscribed", message: CLINE_ERROR_MESSAGES.not_subscribed };
	}

	if (matchesAny(lower, ["401", "unauthorized", "invalid api key", "invalid_api_key"])) {
		return { type: "auth_expired", message: CLINE_ERROR_MESSAGES.auth_expired };
	}

	if (matchesAny(lower, ["429", "rate limit", "too many requests", "rate_limit"])) {
		return { type: "rate_limited", message: CLINE_ERROR_MESSAGES.rate_limited };
	}

	return { type: "unknown", message: CLINE_ERROR_MESSAGES.unknown };
}
