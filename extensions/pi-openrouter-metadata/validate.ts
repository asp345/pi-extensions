import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const MAX_PRICE_PER_TOKEN_USD = 1;
export const EFFORT_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

export function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function displayName(value: unknown): string | undefined {
	const text = string(value);
	if (!text) return undefined;
	const clean = [...text]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 32 && !(code >= 127 && code <= 159);
		})
		.join("")
		.trim();
	return clean ? clean.slice(0, 256) : undefined;
}

export function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Rates already stored by pi, which are trusted catalog data rather than remote input.
 * Negative values are pi's sentinel for variable pricing, as used by the Auto Router
 * models, so they are preserved instead of dropping the model from the baseline.
 */
export function storedRate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function perMillionRate(value: unknown): number | undefined {
	const maximum = MAX_PRICE_PER_TOKEN_USD * 1_000_000;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined;
}

export function price(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_PRICE_PER_TOKEN_USD ? parsed * 1_000_000 : undefined;
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
	const source = record(value);
	if (!source) return undefined;
	const entries = Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length ? Object.fromEntries(entries) : undefined;
}

export function cacheId(value: unknown): string | undefined {
	const id = string(value);
	const controlPattern = String.raw`[\u0000-\u001f\u007f-\u009f]`;
	return id && id.length <= 512 && !new RegExp(controlPattern, "u").test(id) ? id : undefined;
}

export function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function headerValidator(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= 1024 && !/[\r\n]/u.test(value) ? value : undefined;
}
