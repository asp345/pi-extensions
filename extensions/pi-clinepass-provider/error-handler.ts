/**
 * Cline error handler — owns the full error surface pipeline.
 *
 * Three responsibilities:
 * 1. Filter — is this a Cline error? (stopReason=error, provider match)
 * 2. Classify — delegates to classifyClineError from errors.ts
 * 3. Deliver — ctx.ui.notify or console.error fallback
 *
 * @module cline-error-handler
 */

import { PROVIDER_NAME } from "./env.js";
import { classifyClineError } from "./errors.js";

/**
 * Handle a `message_end` event for a Cline provider.
 *
 * Filters for Cline-specific errors, classifies them, and surfaces a
 * user-friendly message. Non-Cline errors and non-error messages are silently
 * ignored (early return).
 */
export function handleClineError(
	event: { message: unknown },
	ctx: {
		hasUI: boolean;
		ui: { notify: (msg: string, type: "info" | "warning" | "error") => void };
		model?: { provider?: string };
	},
): void {
	if (!event.message) return;

	const msg = event.message as {
		stopReason?: string;
		errorMessage?: string;
		provider?: string;
	};

	if (msg.stopReason !== "error" || !msg.errorMessage) return;

	const provider = msg.provider ?? ctx.model?.provider;
	if (provider !== PROVIDER_NAME) return;

	const { message: friendlyMessage } = classifyClineError(msg.errorMessage);

	if (ctx.hasUI) {
		ctx.ui.notify(friendlyMessage, "error");
	} else {
		console.error(`[cline] ${friendlyMessage}`);
	}
}
