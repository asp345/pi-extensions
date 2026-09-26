import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CostOverride, MetadataOverride } from "./types.ts";
import {
	cacheId,
	displayName,
	EFFORT_LEVELS,
	finiteTimestamp,
	headerValidator,
	perMillionRate,
	record,
	stringArray,
} from "./validate.ts";

export const CACHE_VERSION = 1;
const CACHE_FILE = "openrouter-metadata-store.json";

export interface OpenRouterMetadataCacheEntry {
	version: typeof CACHE_VERSION;
	models: Array<MetadataOverride & { id: string }>;
	checkedAt: number;
	etag?: string;
	lastModified?: string;
}

export interface OpenRouterMetadataCache {
	read(): Promise<OpenRouterMetadataCacheEntry | undefined>;
	write(entry: OpenRouterMetadataCacheEntry): Promise<void>;
}

export function readInitialMetadataCache(): OpenRouterMetadataCacheEntry | undefined {
	try {
		return parseCacheEntry(JSON.parse(readFileSync(join(getAgentDir(), CACHE_FILE), "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

export function fileMetadataCache(path = join(getAgentDir(), CACHE_FILE)): OpenRouterMetadataCache {
	let writeQueue = Promise.resolve();
	return {
		read: async () => {
			try {
				return parseCacheEntry(JSON.parse(await readFile(path, "utf8")) as unknown);
			} catch {
				return undefined;
			}
		},
		write: (entry) => {
			const write = writeQueue
				.catch(() => undefined)
				.then(async () => {
					const directory = dirname(path);
					await mkdir(directory, { recursive: true, mode: 0o700 });
					const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
					let moved = false;
					const file = await open(temporary, "wx", 0o600);
					try {
						await file.writeFile(`${JSON.stringify(entry, null, 2)}\n`);
						await file.sync();
						await file.close();
						await rename(temporary, path);
						moved = true;
						const parent = await open(directory, "r");
						try {
							await parent.sync();
						} finally {
							await parent.close();
						}
					} finally {
						await file.close().catch(() => undefined);
						if (!moved) await unlink(temporary).catch(() => undefined);
					}
				});
			writeQueue = write;
			return write;
		},
	};
}

function parseCacheEntry(value: unknown): OpenRouterMetadataCacheEntry | undefined {
	const root = record(value);
	if (root?.version !== CACHE_VERSION || !Array.isArray(root.models) || root.models.length > 20_000) {
		return undefined;
	}
	const models: OpenRouterMetadataCacheEntry["models"] = [];
	for (const item of root.models) {
		const cached = record(item);
		const id = cacheId(cached?.id);
		if (!cached || !id) continue;
		models.push({ id, ...cachedMetadataOverride(cached) });
	}
	const checkedAt = finiteTimestamp(root.checkedAt);
	if (checkedAt === undefined) return undefined;
	const entry: OpenRouterMetadataCacheEntry = {
		version: CACHE_VERSION,
		models,
		checkedAt: Math.min(checkedAt, Date.now()),
	};
	const etag = headerValidator(root.etag);
	const lastModified = headerValidator(root.lastModified);
	if (etag) entry.etag = etag;
	if (lastModified) entry.lastModified = lastModified;
	return entry;
}

function cachedMetadataOverride(value: Record<string, unknown>): MetadataOverride {
	const input = stringArray(value.input).filter(
		(item): item is "text" | "image" => item === "text" || item === "image",
	);
	const rawCost = record(value.cost);
	const cost: CostOverride = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const parsed = perMillionRate(rawCost?.[key]);
		if (parsed !== undefined) cost[key] = parsed;
	}
	const result: MetadataOverride = {};
	const name = displayName(value.name);
	const thinking = cachedThinkingLevelMap(value.thinkingLevelMap);
	if (name) result.name = name;
	if (value.reasoning === true) result.reasoning = true;
	if (thinking) result.thinkingLevelMap = thinking;
	if (input.length) result.input = input;
	if (Object.keys(cost).length) result.cost = cost;
	return result;
}

function cachedThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	const source = record(value);
	if (!source) return undefined;
	const result: ThinkingLevelMap = {};
	for (const level of ["off", ...EFFORT_LEVELS] as const) {
		const mapped = source[level];
		if (mapped === null || (typeof mapped === "string" && EFFORT_LEVELS.some((effort) => effort === mapped))) {
			result[level] = mapped;
		}
	}
	return Object.keys(result).length ? result : undefined;
}
