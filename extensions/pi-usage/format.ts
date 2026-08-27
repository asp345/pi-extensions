import type { UsageLimit, UsageReport } from "./types.ts";
import { resolveUsedFraction } from "./types.ts";

const STATUS_ICON: Record<string, string> = {
	ok: "✓",
	warning: "!",
	exhausted: "✗",
	unknown: "?",
};

const STATUS_COLOR: Record<string, string> = {
	ok: "success",
	warning: "warning",
	exhausted: "error",
	unknown: "dim",
};

export function formatReport(report: UsageReport, fg: (color: string, text: string) => string): string[] {
	const lines: string[] = [];
	lines.push(fg("accent", report.provider));

	if (report.limits.length === 0) {
		lines.push(`  ${fg("dim", "No usage limits reported.")}`);
		return lines;
	}

	for (const limit of report.limits) {
		lines.push(formatLimit(limit, fg));
	}

	const meta = report.metadata;
	if (meta) {
		const metaParts: string[] = [];
		if (typeof meta.endpoint === "string") metaParts.push(meta.endpoint);
		if (typeof meta.email === "string") metaParts.push(meta.email);
		if (typeof meta.accountId === "string") metaParts.push(`account ${meta.accountId}`);
		if (typeof meta.planType === "string") metaParts.push(`plan: ${meta.planType}`);
		if (metaParts.length > 0) lines.push(`  ${fg("dim", metaParts.join(" · "))}`);
	}

	return lines;
}

function formatLimit(limit: UsageLimit, fg: (color: string, text: string) => string): string {
	const fraction = resolveUsedFraction(limit);
	const status = limit.status ?? "unknown";
	const icon = STATUS_ICON[status] ?? "?";
	const color = STATUS_COLOR[status] ?? "dim";

	const bar = formatBar(fraction, fg);
	const usedLabel = formatUsed(fraction, limit);
	const windowLabel = formatWindow(limit, fg);

	return `  ${fg(color, icon)} ${limit.label}: ${bar} ${usedLabel}${windowLabel ? ` ${fg("dim", windowLabel)}` : ""}`;
}

function formatBar(fraction: number | undefined, fg: (color: string, text: string) => string): string {
	const width = 20;
	if (fraction === undefined) return fg("dim", "░".repeat(width));
	const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width);
	const empty = width - filled;
	const filledBar = "█".repeat(filled);
	const emptyBar = "░".repeat(empty);
	const color = fraction >= 1 ? "error" : fraction >= 0.9 ? "warning" : "accent";
	return `${fg(color, filledBar)}${fg("dim", emptyBar)}`;
}

function formatUsed(fraction: number | undefined, limit: UsageLimit): string {
	if (fraction === undefined) return "n/a";
	const percent = Math.round(fraction * 100);
	if (limit.amount.unit === "usd") {
		const used = limit.amount.used;
		const limitValue = limit.amount.limit;
		if (typeof used === "number") {
			return typeof limitValue === "number" ? `$${used.toFixed(2)}/$${limitValue.toFixed(2)}` : `$${used.toFixed(2)}`;
		}
	}
	return `${percent}%`;
}

function formatWindow(limit: UsageLimit, _fg: (color: string, text: string) => string): string {
	if (!limit.window) return "";
	const parts: string[] = [];
	if (limit.window.label) parts.push(limit.window.label);
	if (typeof limit.window.resetsAt === "number") {
		const remaining = limit.window.resetsAt - Date.now();
		if (remaining > 0) parts.push(`resets in ${formatDuration(remaining)}`);
	}
	return parts.join(" · ");
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}
