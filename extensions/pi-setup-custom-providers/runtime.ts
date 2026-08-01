import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { pruneModelsStore } from "./config.ts";
import { discoverProviderModels, mergeConfiguredModels } from "./discovery.ts";
import type { CustomModelConfig, CustomProviderConfig, ModelMetadata, ModelsFile } from "./types.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./types.ts";

const BUILTIN_PROVIDERS = new Set<string>(getBuiltinProviders());
const REFRESH_TTL_MS = 24 * 60 * 60_000;
const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Pi reads an unknown OpenAI-compatible endpoint as speaking OpenAI's role
 * vocabulary and sends the system prompt as a `developer` message for every
 * reasoning model. Most gateways validate against the standard four roles and
 * reject that with a bare 400, so custom providers default to `system`, which
 * carries the same authority on the endpoints that accept either name.
 */
const CUSTOM_PROVIDER_COMPAT = { supportsDeveloperRole: false } as const;

/** Values left unset in the wizard must not mask the defaults above. */
function assigned<T extends object>(value: T | undefined): Partial<T> {
	return Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function toProviderModel(
	model: CustomModelConfig,
	providerCompat?: CustomProviderConfig["compat"],
): ProviderModelConfig {
	const compat = { ...CUSTOM_PROVIDER_COMPAT, ...assigned(providerCompat), ...assigned(model.compat) };
	return {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning === true,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: model.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
		headers: model.headers ? { ...model.headers } : undefined,
		compat: compat as ProviderModelConfig["compat"],
	};
}

function storedMetadata(models: readonly Model<Api>[]): Map<string, ModelMetadata> {
	return new Map(
		models.map((model) => [
			model.id.trim().toLowerCase(),
			{
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		]),
	);
}

/**
 * Refreshes one provider's catalog.
 *
 * Repeats inside the TTL reuse the previous result, so opening `/model` does
 * not re-query the provider every time. Offline refreshes fall back to the
 * catalog pi persisted for this provider, and a failing endpoint never removes
 * models the user configured.
 *
 * A persisted catalog outranks the configured metadata it was derived from, so
 * one that is unreadable, undated, or older than the maximum age is deleted
 * rather than merged. The next networked refresh writes a fresh one.
 */
function refreshModels(providerId: string, config: CustomProviderConfig) {
	let checkedAt = Number.NEGATIVE_INFINITY;
	let cached: CustomModelConfig[] | undefined;
	let inflight: Promise<CustomModelConfig[]> | undefined;

	return async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
		const configured = config.models ?? [];
		const asProviderModel = (model: CustomModelConfig) => toProviderModel(model, config.compat);
		const persistedCatalog = async (): Promise<Map<string, ModelMetadata>> => {
			const persisted = await context.store.read().catch(() => undefined);
			if (!persisted) return new Map();
			const age = persisted.checkedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - persisted.checkedAt;
			if (age > CATALOG_MAX_AGE_MS) {
				await context.store.delete().catch(() => undefined);
				return new Map();
			}
			return persisted.models.length > 0 ? storedMetadata(persisted.models) : new Map();
		};
		const offline = async (): Promise<ProviderModelConfig[]> => {
			if (cached) return cached.map(asProviderModel);
			const discovered = await persistedCatalog();
			if (discovered.size === 0) return configured.map(asProviderModel);
			return mergeConfiguredModels(configured, discovered).map(asProviderModel);
		};
		if (!context.allowNetwork || context.signal?.aborted) return offline();
		if (!context.force && Date.now() - checkedAt < REFRESH_TTL_MS) return offline();
		const stored = await context.store.read().catch(() => undefined);
		if (!context.force && stored?.checkedAt !== undefined && Date.now() - stored.checkedAt < REFRESH_TTL_MS) {
			return offline();
		}
		if (!context.force && inflight) return offline();

		const auth =
			context.credential?.type === "api_key"
				? { auth: { apiKey: context.credential.key }, env: context.credential.env }
				: undefined;
		const request = (async () => {
			const discovered = await discoverProviderModels(config, auth, context.signal).catch(
				() => new Map<string, ModelMetadata>(),
			);
			if (context.signal?.aborted) return cached ?? configured;
			if (discovered.size === 0) return cached ?? configured;
			const merged = mergeConfiguredModels(configured, discovered);
			checkedAt = Date.now();
			cached = merged;
			if (config.baseUrl && config.api) {
				const models = merged.map((model) => ({
					...asProviderModel(model),
					api: config.api as Api,
					provider: providerId,
					baseUrl: config.baseUrl as string,
				})) as Model<Api>[];
				await context.store.write({ models, checkedAt }).catch(() => undefined);
			}
			return merged;
		})();

		inflight = request;
		if (context.force) {
			try {
				return (await request).map(asProviderModel);
			} finally {
				if (inflight === request) inflight = undefined;
			}
		}
		void request
			.catch(() => undefined)
			.finally(() => {
				if (inflight === request) inflight = undefined;
			});
		return offline();
	};
}

function providerRegistration(providerId: string, config: CustomProviderConfig): ProviderConfig | undefined {
	if (!config.baseUrl || !config.api) return undefined;
	return {
		name: config.name,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		api: config.api as Api,
		headers: config.headers ? { ...config.headers } : undefined,
		authHeader: config.authHeader,
		models: (config.models ?? []).map((model) => toProviderModel(model, config.compat)),
		refreshModels: refreshModels(providerId, config),
	};
}

/**
 * Registers custom providers and drops the ones removed from models.json.
 * Providers pi ships itself are left alone so their catalogs stay intact.
 *
 * Pi's unregisterProvider clears only its in-memory maps and never deletes the
 * matching models-store entry, so a removed custom provider would otherwise
 * keep serving its last catalog offline. Each registrar run prunes store
 * entries that belong to no live provider once registration settles; built-in
 * providers are never candidates for pruning.
 */
export function createProviderRegistrar(pi: ExtensionAPI): (data: ModelsFile) => string[] {
	const registered = new Set<string>();
	return (data) => {
		const problems: string[] = [];
		const configured = new Set(Object.keys(data.providers).filter((providerId) => !BUILTIN_PROVIDERS.has(providerId)));
		for (const providerId of registered) {
			if (configured.has(providerId)) continue;
			pi.unregisterProvider(providerId);
			registered.delete(providerId);
		}
		const live = new Set([...BUILTIN_PROVIDERS, ...configured]);
		pruneModelsStore(live).catch((error: unknown) =>
			problems.push(`models-store cleanup: ${error instanceof Error ? error.message : String(error)}`),
		);
		for (const providerId of configured) {
			const config = data.providers[providerId];
			if (!config) continue;
			const registration = providerRegistration(providerId, config);
			if (!registration) {
				problems.push(`${providerId}: set a base URL and API format before it can be used`);
				continue;
			}
			try {
				pi.registerProvider(providerId, registration);
				registered.add(providerId);
			} catch (error) {
				problems.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return problems;
	};
}
