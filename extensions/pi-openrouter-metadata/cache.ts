import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CostOverride, MetadataOverride, OpenRouterModel } from "./types.ts";
import {
	cacheId,
	displayName,
	EFFORT_LEVELS,
	finiteTimestamp,
	headerValidator,
	perMillionRate,
	positiveInteger,
	record,
	storedRate,
	string,
	stringArray,
	stringRecord,
} from "./validate.ts";

export const CACHE_VERSION = 1;
const CACHE_FILE = "openrouter-metadata-store.json";
const PI_MODELS_STORE_FILE = "models-store.json";

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

export function readPiOpenRouterModels(): OpenRouterModel[] {
	try {
		const root = record(JSON.parse(readFileSync(join(getAgentDir(), PI_MODELS_STORE_FILE), "utf8")) as unknown);
		const openrouter = record(root?.openrouter);
		if (!Array.isArray(openrouter?.models)) return [];
		return openrouter.models.flatMap((value) => {
			const model = storedOpenRouterModel(value);
			return model ? [model] : [];
		});
	} catch {
		return [];
	}
}

function storedOpenRouterModel(value: unknown): OpenRouterModel | undefined {
	const source = record(value);
	const id = cacheId(source?.id);
	const name = displayName(source?.name);
	const baseUrl = string(source?.baseUrl);
	const input = stringArray(source?.input).filter(
		(item): item is "text" | "image" => item === "text" || item === "image",
	);
	const rawCost = record(source?.cost);
	const inputCost = storedRate(rawCost?.input);
	const outputCost = storedRate(rawCost?.output);
	const cacheRead = storedRate(rawCost?.cacheRead);
	const cacheWrite = storedRate(rawCost?.cacheWrite);
	const contextWindow = positiveInteger(source?.contextWindow);
	const maxTokens = positiveInteger(source?.maxTokens);
	if (
		!source ||
		!id ||
		!name ||
		!baseUrl ||
		source.api !== "openai-completions" ||
		source.provider !== "openrouter" ||
		typeof source.reasoning !== "boolean" ||
		!input.length ||
		inputCost === undefined ||
		outputCost === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined ||
		contextWindow === undefined ||
		maxTokens === undefined
	) {
		return undefined;
	}
	const compat = record(source.compat);
	const headers = stringRecord(source.headers);
	return {
		id,
		name,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl,
		reasoning: source.reasoning,
		thinkingLevelMap: cachedThinkingLevelMap(source.thinkingLevelMap),
		input,
		cost: { input: inputCost, output: outputCost, cacheRead, cacheWrite },
		contextWindow,
		maxTokens,
		compat: compat ? (structuredClone(compat) as OpenRouterModel["compat"]) : undefined,
		headers,
	};
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
	const contextWindow = positiveInteger(value.contextWindow);
	const maxTokens = positiveInteger(value.maxTokens);
	if (name) result.name = name;
	if (value.reasoning === true) result.reasoning = true;
	if (thinking) result.thinkingLevelMap = thinking;
	if (input.length) result.input = input;
	if (Object.keys(cost).length) result.cost = cost;
	if (contextWindow) result.contextWindow = contextWindow;
	if (maxTokens) result.maxTokens = maxTokens;
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
