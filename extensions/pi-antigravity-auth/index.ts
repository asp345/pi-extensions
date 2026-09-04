import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AgyModelDefinition,
	MODEL_CATALOG_TTL_MS,
	refreshModelCatalog,
	STATIC_MODEL_CATALOG,
} from "./agy/index.ts";
import { modelThinkingLevelMap } from "./model-tiers.ts";
import { login, refreshOAuth } from "./oauth-callback.ts";
import { rememberRefresh } from "./session.ts";
import { streamAntigravity } from "./stream.ts";

export { convertMessages } from "./gemini.ts";
export { resolveModel } from "./model-tiers.ts";
export { requestSessionKey } from "./session.ts";
export { parseSse } from "./sse.ts";

const PROVIDER_ID = "antigravity";

export default function antigravityAuth(pi: ExtensionAPI): void {
	const toProviderModels = (definitions: AgyModelDefinition[]) =>
		definitions.map((model) => ({
			id: model.id.replace(/^antigravity-/, ""),
			name: model.name,
			reasoning: model.reasoning,
			thinkingLevelMap: modelThinkingLevelMap(model),
			input: model.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	const staticModels = toProviderModels(STATIC_MODEL_CATALOG);
	const provider: Parameters<ExtensionAPI["registerProvider"]>[1] = {
		name: "Google Antigravity",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		api: "google-generative-ai",
		models: staticModels,
		refreshModels: async (context) => {
			const storedModels = context.stored?.models.map((model) => ({
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}));
			const fallback = storedModels?.length ? storedModels : staticModels;
			const checkedAt = context.stored?.checkedAt ?? 0;
			if (
				!context.allowNetwork ||
				(!context.force && Date.now() - checkedAt < MODEL_CATALOG_TTL_MS) ||
				context.credential?.type !== "oauth"
			) {
				return fallback;
			}

			try {
				const refreshed = toProviderModels(await refreshModelCatalog(context.credential.access, context.signal));
				const refreshedAt = Date.now();
				await context.publish({
					persist: {
						checkedAt: refreshedAt,
						models: refreshed.map((model) => ({
							...model,
							api: "google-generative-ai",
							provider: PROVIDER_ID,
							baseUrl: "https://cloudcode-pa.googleapis.com",
						})),
					},
				});
				return refreshed;
			} catch {
				return fallback;
			}
		},
		oauth: {
			name: "Google Antigravity",
			usesCallbackServer: true,
			login,
			refreshToken: refreshOAuth,
			getApiKey: (credentials: OAuthCredentials) => {
				rememberRefresh(credentials.access, credentials.refresh);
				return credentials.access;
			},
		},
		streamSimple: streamAntigravity,
	};
	pi.registerProvider(PROVIDER_ID, provider);
}
