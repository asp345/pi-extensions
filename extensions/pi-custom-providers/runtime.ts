import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { removeModelsStoreProviders } from "./config.ts";
import { discoverProviderModels } from "./discovery.ts";
import type { CustomProviderConfig, CustomProvidersFile, ModelMetadata } from "./types.ts";
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

/** Values left unset in the wizard must not mask provider defaults. */
function assigned<T extends object>(value: T | undefined): Partial<T> {
	return Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function toProviderModel(
	metadata: ModelMetadata,
	providerCompat?: CustomProviderConfig["compat"],
): ProviderModelConfig {
	return {
		id: metadata.id,
		name: metadata.name ?? metadata.id,
		reasoning: metadata.reasoning ?? true,
		thinkingLevelMap: metadata.thinkingLevelMap ? { ...metadata.thinkingLevelMap } : undefined,
		input: metadata.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: metadata.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: metadata.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat: { ...CUSTOM_PROVIDER_COMPAT, ...assigned(providerCompat) } as ProviderModelConfig["compat"],
	};
}

function storedProviderModel(model: Model<Api>): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		reasoning: true,
		thinkingLevelMap: model.thinkingLevelMap,
		input: [...model.input],
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers,
		compat: model.compat,
	};
}

function refreshModels(providerId: string, config: CustomProviderConfig) {
	let checkedAt = Number.NEGATIVE_INFINITY;
	let cached: ProviderModelConfig[] | undefined;

	return async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
		const persisted = context.stored;
		const offline = async (): Promise<ProviderModelConfig[]> => {
			if (cached) return cached;
			if (!persisted) return [];
			const age = persisted.checkedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - persisted.checkedAt;
			if (age > CATALOG_MAX_AGE_MS) {
				await context.publish({ persist: null }).catch(() => undefined);
				return [];
			}
			return persisted.models.map(storedProviderModel);
		};

		if (!context.allowNetwork || context.signal.aborted) return offline();
		const lastChecked = Math.max(checkedAt, persisted?.checkedAt ?? Number.NEGATIVE_INFINITY);
		if (!context.force && Date.now() - lastChecked < REFRESH_TTL_MS) return offline();

		const auth =
			context.credential?.type === "api_key"
				? { auth: { apiKey: context.credential.key }, env: context.credential.env }
				: undefined;
		try {
			const discovered = await discoverProviderModels(config, auth, context.signal);
			if (context.signal.aborted) return offline();
			cached = [...discovered.values()].map((metadata) => toProviderModel(metadata, config.compat));
			checkedAt = Date.now();
			if (config.baseUrl && config.api) {
				const models = cached.map((model) => ({
					...model,
					api: config.api as Api,
					provider: providerId,
					baseUrl: config.baseUrl as string,
				})) as Model<Api>[];
				await context.publish({ persist: { models, checkedAt } }).catch(() => undefined);
			}
			return cached;
		} catch (error) {
			await offline();
			throw error;
		}
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
		models: [],
		refreshModels: refreshModels(providerId, config),
	};
}

/** Registers complete custom providers without replacing Pi's built-in providers. */
export function createProviderRegistrar(pi: ExtensionAPI): (data: CustomProvidersFile) => string[] {
	const registered = new Set<string>();
	return (data) => {
		const problems: string[] = [];
		const configured = new Set(Object.keys(data.providers).filter((providerId) => !BUILTIN_PROVIDERS.has(providerId)));
		const removed = new Set<string>();
		for (const providerId of registered) {
			if (configured.has(providerId)) continue;
			pi.unregisterProvider(providerId);
			registered.delete(providerId);
			removed.add(providerId);
		}
		void removeModelsStoreProviders(removed).catch(() => undefined);
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
