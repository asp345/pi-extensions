import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CACHE_VERSION,
	fileMetadataCache,
	type OpenRouterMetadataCache,
	type OpenRouterMetadataCacheEntry,
	readInitialMetadataCache,
} from "./cache.ts";
import { applyMetadataOverrides, buildMetadataOverrides, readCatalog } from "./catalog.ts";
import type { MetadataOverride } from "./types.ts";

export type { OpenRouterMetadataCache, OpenRouterMetadataCacheEntry } from "./cache.ts";
export { fileMetadataCache, readPiOpenRouterModels } from "./cache.ts";
export { mergeOpenRouterModels } from "./catalog.ts";
export type { MetadataOverride } from "./types.ts";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BASE_PROVIDER = "__piConfigOpenRouterMetadataBase" as const;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type WrappedProvider = Provider<"openai-completions"> & { [BASE_PROVIDER]?: Provider<"openai-completions"> };

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
