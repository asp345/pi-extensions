import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model, Provider, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 16_000_000;
const MAX_PRICE_PER_TOKEN_USD = 1;
const CACHE_VERSION = 1;
const CACHE_FILE = "openrouter-metadata-store.json";
const PI_MODELS_STORE_FILE = "models-store.json";
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const BASE_PROVIDER = "__piConfigOpenRouterMetadataBase" as const;

type OpenRouterModel = Model<"openai-completions">;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type WrappedProvider = Provider<"openai-completions"> & { [BASE_PROVIDER]?: Provider<"openai-completions"> };
type CostOverride = Partial<Pick<OpenRouterModel["cost"], "input" | "output" | "cacheRead" | "cacheWrite">>;

interface RemoteModel {
	id: string;
	value: Record<string, unknown>;
}

export interface MetadataOverride {
	name?: string;
	reasoning?: true;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ("text" | "image")[];
	cost?: CostOverride;
	contextWindow?: number;
	maxTokens?: number;
}

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

export function reportOpenRouterRefreshFailure(error: unknown, notify: (message: string) => void): void {
	if (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	)
		return;
	const message = error instanceof Error ? error.message : String(error);
	try {
		notify(`OpenRouter metadata refresh failed: ${message}`);
	} catch {}
}

export function mergeOpenRouterModels(baseline: readonly OpenRouterModel[], payload: unknown): OpenRouterModel[] {
	return applyMetadataOverrides(baseline, buildMetadataOverrides(baseline, payload));
}

export function createOpenRouterMetadataProvider(
	provider: Provider<"openai-completions">,
	fetcher: Fetcher = globalThis.fetch,
	cache: OpenRouterMetadataCache = fileMetadataCache(),
	initialCache?: OpenRouterMetadataCacheEntry,
	options: {
		backgroundRefresh?: boolean;
		onModelsChanged?: () => void;
		onRefreshError?: (error: unknown) => void;
	} = {},
): Provider<"openai-completions"> {
	const base = (provider as WrappedProvider)[BASE_PROVIDER] ?? provider;
	let overrides = initialCache
		? new Map(initialCache.models.map(({ id, ...value }) => [id, value]))
		: new Map<string, MetadataOverride>();
	let models = applyMetadataOverrides(base.getModels(), overrides);
	let checkedAt = initialCache?.checkedAt ?? 0;
	let etag = initialCache?.etag;
	let lastModified = initialCache?.lastModified;
	let cacheLoad: Promise<void> | undefined = initialCache ? Promise.resolve() : undefined;
	let networkRefresh: Promise<void> | undefined;

	const loadCache = () => {
		cacheLoad ??= cache.read().then((entry) => {
			if (!entry) return;
			overrides = new Map(entry.models.map(({ id, ...value }) => [id, value]));
			checkedAt = entry.checkedAt;
			etag = entry.etag;
			lastModified = entry.lastModified;
		});
		return cacheLoad;
	};
	const persist = () =>
		cache.write({
			version: CACHE_VERSION,
			models: [...overrides].map(([id, value]) => ({ id, ...value })),
			checkedAt,
			etag,
			lastModified,
		});

	const refreshModels: NonNullable<Provider<"openai-completions">["refreshModels"]> = async (context) => {
		let baseFailure: { error: unknown } | undefined;
		await Promise.all([
			Promise.resolve(base.refreshModels?.(context)).catch((error: unknown) => {
				baseFailure = { error };
			}),
			loadCache(),
		]);
		models = applyMetadataOverrides(base.getModels(), overrides);
		if (baseFailure) throw baseFailure.error;
		if (!context.allowNetwork || context.signal?.aborted) return;
		if (!context.force && Date.now() - checkedAt < CACHE_TTL_MS) return;
		if (!context.force && networkRefresh) return options.backgroundRefresh ? undefined : networkRefresh;

		const execute = async () => {
			if (context.signal?.aborted) return;
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
			const response = await fetcher(CATALOG_URL, {
				headers: {
					accept: "application/json",
					...(etag ? { "if-none-match": etag } : {}),
					...(lastModified ? { "if-modified-since": lastModified } : {}),
				},
				redirect: "error",
				signal,
			});
			if (context.signal?.aborted) return;
			if (response.status === 304) {
				await response.body?.cancel();
				checkedAt = Date.now();
				await persist();
				return;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(`OpenRouter model refresh failed with HTTP ${response.status}.`);
			}
			const payload = await readCatalog(response);
			if (context.signal?.aborted) return;
			const baseline = base.getModels();
			overrides = buildMetadataOverrides(baseline, payload);
			models = applyMetadataOverrides(baseline, overrides);
			etag = response.headers.get("etag") ?? undefined;
			lastModified = response.headers.get("last-modified") ?? undefined;
			checkedAt = Date.now();
			await persist();
		};
		const predecessor = networkRefresh;
		const pending = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(execute);
		networkRefresh = pending;
		if (!context.force && options.backgroundRefresh) {
			void pending
				.then(() => options.onModelsChanged?.())
				.catch((error: unknown) => options.onRefreshError?.(error))
				.finally(() => {
					if (networkRefresh === pending) networkRefresh = undefined;
				});
			return;
		}
		try {
			await pending;
		} finally {
			if (networkRefresh === pending) networkRefresh = undefined;
		}
	};

	const wrapped: WrappedProvider = {
		...base,
		[BASE_PROVIDER]: base,
		getModels: () => models,
		refreshModels,
	};
	return wrapped;
}

export default function openrouterMetadata(pi: ExtensionAPI): void {
	const cache = fileMetadataCache();
	let generation = 0;
	let active = false;
	let notify: ((message: string) => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		active = true;
		notify = (message) => ctx.ui.notify(message, "warning");
		const activeGeneration = ++generation;
		const current = ctx.modelRegistry.getProvider("openrouter") as WrappedProvider | undefined;
		const base = current?.[BASE_PROVIDER] ?? current;
		if (!base) return;
		const provider = createOpenRouterMetadataProvider(base, globalThis.fetch, cache, readInitialMetadataCache(), {
			backgroundRefresh: true,
			onModelsChanged: () => {
				if (!active || generation !== activeGeneration) return;
				try {
					pi.registerProvider(provider);
				} catch {}
			},
			onRefreshError: (error) => {
				if (active && generation === activeGeneration && notify) {
					reportOpenRouterRefreshFailure(error, notify);
				}
			},
		});
		pi.registerProvider(provider);
		void ctx.modelRegistry
			.refresh()
			.then(async () => {
				if (generation !== activeGeneration || ctx.model?.provider !== "openrouter") return;
				const refreshed = ctx.modelRegistry.find("openrouter", ctx.model.id);
				if (refreshed) await pi.setModel(refreshed);
			})
			.catch((error: unknown) => {
				if (generation !== activeGeneration || !notify) return;
				reportOpenRouterRefreshFailure(error, notify);
			});
	});
	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== "openrouter") return;
		const refreshed = ctx.modelRegistry.find("openrouter", event.model.id);
		if (refreshed && refreshed !== event.model) await pi.setModel(refreshed);
	});
	pi.on("session_shutdown", () => {
		active = false;
		notify = undefined;
		generation += 1;
		pi.unregisterProvider("openrouter");
	});
}

function readInitialMetadataCache(): OpenRouterMetadataCacheEntry | undefined {
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

function stringRecord(value: unknown): Record<string, string> | undefined {
	const source = record(value);
	if (!source) return undefined;
	const entries = Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length ? Object.fromEntries(entries) : undefined;
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

function cacheId(value: unknown): string | undefined {
	const id = string(value);
	return id && id.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(id) ? id : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function headerValidator(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= 1024 && !/[\r\n]/u.test(value) ? value : undefined;
}

function buildMetadataOverrides(baseline: readonly OpenRouterModel[], payload: unknown): Map<string, MetadataOverride> {
	const knownIds = new Set(baseline.map((model) => model.id));
	const overrides = new Map<string, MetadataOverride>();
	for (const remote of parseCatalog(payload)) {
		if (!knownIds.has(remote.id)) continue;
		overrides.set(remote.id, metadataOverride(remote.value));
	}
	return overrides;
}

function applyMetadataOverrides(
	baseline: readonly OpenRouterModel[],
	overrides: ReadonlyMap<string, MetadataOverride>,
): OpenRouterModel[] {
	return baseline.map((model) => {
		const cloned = cloneModel(model);
		const value = overrides.get(model.id);
		if (!value) return cloned;
		return {
			...cloned,
			name: value.name ?? cloned.name,
			reasoning: value.reasoning ?? cloned.reasoning,
			thinkingLevelMap: value.thinkingLevelMap ? { ...value.thinkingLevelMap } : cloned.thinkingLevelMap,
			input: value.input ? [...value.input] : cloned.input,
			cost: value.cost ? { ...cloned.cost, ...value.cost } : cloned.cost,
			contextWindow: value.contextWindow ?? cloned.contextWindow,
			maxTokens: value.maxTokens ?? cloned.maxTokens,
		};
	});
}

function metadataOverride(value: Record<string, unknown>): MetadataOverride {
	const reasoning = record(value.reasoning);
	const pricing = record(value.pricing);
	const architecture = record(value.architecture);
	const topProvider = record(value.top_provider);
	const input = stringArray(architecture?.input_modalities).filter(
		(item): item is "text" | "image" => item === "text" || item === "image",
	);
	const cost: CostOverride = {};
	const inputCost = price(pricing?.prompt);
	const outputCost = price(pricing?.completion);
	const cacheRead = price(pricing?.input_cache_read);
	const cacheWrite = price(pricing?.input_cache_write);
	if (inputCost !== undefined) cost.input = inputCost;
	if (outputCost !== undefined) cost.output = outputCost;
	if (cacheRead !== undefined) cost.cacheRead = cacheRead;
	if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
	const supportedParameters = new Set(stringArray(value.supported_parameters));
	const remoteReasoning = reasoning !== undefined || supportedParameters.has("reasoning");
	return {
		name: displayName(value.name),
		reasoning: remoteReasoning ? true : undefined,
		thinkingLevelMap: thinkingLevelMap(reasoning),
		input: input.length ? input : undefined,
		cost: Object.keys(cost).length ? cost : undefined,
		contextWindow: positiveInteger(value.context_length) ?? positiveInteger(topProvider?.context_length),
		maxTokens: positiveInteger(topProvider?.max_completion_tokens),
	};
}

function thinkingLevelMap(reasoning: Record<string, unknown> | undefined): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const efforts = stringArray(reasoning.supported_efforts);
	const supported = new Set(efforts.filter((effort) => EFFORT_LEVELS.some((level) => level === effort)));
	if (!supported.size) return undefined;
	const map: ThinkingLevelMap = {};
	if (reasoning.mandatory === true) map.off = null;
	for (const level of EFFORT_LEVELS) map[level] = supported.has(level) ? level : null;
	return map;
}

function parseCatalog(payload: unknown): RemoteModel[] {
	const root = record(payload);
	if (!root || !Array.isArray(root.data)) throw new Error("OpenRouter model refresh returned an invalid catalog.");
	if (root.data.length > 20_000) throw new Error("OpenRouter model refresh returned too many models.");
	const models: RemoteModel[] = [];
	for (const item of root.data) {
		const value = record(item);
		const id = string(value?.id);
		if (value && id) models.push({ id, value });
	}
	if (!models.length) throw new Error("OpenRouter model refresh returned an empty catalog.");
	return models;
}

async function readCatalog(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
		await response.body?.cancel();
		throw new Error("OpenRouter model catalog exceeds the response limit.");
	}
	if (!response.body) return JSON.parse(await response.text()) as unknown;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_CATALOG_BYTES) {
				await reader.cancel();
				throw new Error("OpenRouter model catalog exceeds the response limit.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function cloneModel(model: OpenRouterModel): OpenRouterModel {
	return {
		...model,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: [...model.input],
		cost: model.cost.tiers
			? { ...model.cost, tiers: model.cost.tiers.map((tier) => ({ ...tier })) }
			: { ...model.cost },
		compat: model.compat ? { ...model.compat } : undefined,
		headers: model.headers ? { ...model.headers } : undefined,
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function displayName(value: unknown): string | undefined {
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

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Rates already stored by pi, which are trusted catalog data rather than remote input.
 * Negative values are pi's sentinel for variable pricing, as used by the Auto Router
 * models, so they are preserved instead of dropping the model from the baseline.
 */
function storedRate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function perMillionRate(value: unknown): number | undefined {
	const maximum = MAX_PRICE_PER_TOKEN_USD * 1_000_000;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined;
}

function price(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_PRICE_PER_TOKEN_USD ? parsed * 1_000_000 : undefined;
}
