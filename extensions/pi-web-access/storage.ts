import { randomUUID } from "node:crypto";

export const MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_LINES = 300;
export const MAX_SLICE_CHARS = 20_000;
const MAX_RECORDS = 24;
const MAX_STORE_BYTES = 12 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}
export interface QueryResult {
	query: string;
	provider?: "openai" | "gemini";
	answer: string;
	results: SearchResult[];
	error?: string;
}
export interface FetchedContent {
	url: string;
	title: string;
	content: string;
	error?: string;
}
export type StoredRecord =
	| { id: string; type: "search"; createdAt: number; items: QueryResult[] }
	| { id: string; type: "fetch"; createdAt: number; items: FetchedContent[] }
	| { id: string; type: "research"; createdAt: number; item: unknown };

const records = new Map<string, StoredRecord>();

export function newId(): string {
	return randomUUID().replaceAll("-", "").slice(0, 16);
}

export function put(record: StoredRecord): void {
	prune();
	if (recordBytes(record) > MAX_STORE_BYTES) throw new Error("Stored result exceeds the storage limit");
	records.delete(record.id);
	records.set(record.id, record);
	while (records.size > MAX_RECORDS || totalBytes() > MAX_STORE_BYTES) {
		const oldest = records.keys().next().value as string | undefined;
		if (!oldest || oldest === record.id) break;
		records.delete(oldest);
	}
}

export function get(id: string): StoredRecord | undefined {
	prune();
	const record = records.get(id);
	if (!record) return undefined;
	records.delete(id);
	records.set(id, record);
	return record;
}

export function clear(): void {
	records.clear();
}

export function boundedText(
	text: string,
	maxChars = MAX_OUTPUT_CHARS,
	maxLines = MAX_OUTPUT_LINES,
): { text: string; truncated: boolean } {
	let value = text;
	let truncated = false;
	if (value.length > maxChars) {
		value = value.slice(0, maxChars);
		truncated = true;
	}
	const lines = value.split("\n");
	if (lines.length > maxLines) {
		value = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	return { text: value, truncated };
}

export async function readBytes(response: Response, max: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) throw new Error("Response is too large");
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			throw new Error("Response is too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, size);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function combinedSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

export function sliceText(
	text: string,
	offset = 0,
	limit = MAX_SLICE_CHARS,
): {
	text: string;
	offset: number;
	nextOffset: number | null;
	total: number;
	truncated: boolean;
} {
	if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
		throw new Error(`offset must be an integer from 0 to ${text.length}`);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SLICE_CHARS)
		throw new Error(`limit must be an integer from 1 to ${MAX_SLICE_CHARS}`);
	const raw = text.slice(offset, offset + limit);
	const bounded = boundedText(raw, limit);
	const end = offset + bounded.text.length;
	return {
		text: bounded.text,
		offset,
		nextOffset: end < text.length ? end : null,
		total: text.length,
		truncated: end < text.length,
	};
}

function prune(): void {
	const cutoff = Date.now() - TTL_MS;
	for (const [id, record] of records) if (record.createdAt < cutoff) records.delete(id);
}

function recordBytes(record: StoredRecord): number {
	return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function totalBytes(): number {
	let total = 0;
	for (const record of records.values()) total += recordBytes(record);
	return total;
}
