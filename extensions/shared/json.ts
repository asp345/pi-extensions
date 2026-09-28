import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function toNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function effortLevelMap(reasoning: Record<string, unknown> | undefined): ThinkingLevelMap | undefined {
	const supported = new Set(stringArray(reasoning?.supported_efforts));
	if (!EFFORT_LEVELS.some((level) => supported.has(level))) return undefined;
	const map: ThinkingLevelMap = {};
	if (reasoning?.mandatory === true) map.off = null;
	for (const level of EFFORT_LEVELS) map[level] = supported.has(level) ? level : null;
	return map;
}

export async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
	const tooLarge = new Error(`Response body exceeds ${maxBytes} bytes.`);
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw tooLarge;
	}
	if (!response.body) return JSON.parse(await response.text()) as unknown;
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.byteLength;
		if (bytes > maxBytes) throw tooLarge;
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, path);
}
