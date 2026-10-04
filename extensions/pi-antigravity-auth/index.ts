import { isModelType, type OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelThinkingLevelMap } from "./model-resolver.ts";
import { type AgyModelDefinition, MODEL_CATALOG_TTL_MS, refreshModelCatalog, STATIC_MODEL_CATALOG } from "./models.ts";
import { login, refreshOAuth } from "./oauth.ts";
import { rememberRefresh } from "./session.ts";
import { streamAntigravity } from "./stream.ts";

export { convertMessages } from "./gemini.ts";
export { resolveModel } from "./model-resolver.ts";
export { requestSessionKey } from "./session.ts";
export { parseSse } from "./sse.ts";

const PROVIDER_ID = "antigravity";

export default function antigravityAuth(pi: ExtensionAPI): void {
	const toProviderModels = (definitions: AgyModelDefinition[]) =>
		definitions.map((model) => ({
			id: model.id,
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
			const storedModels = context.stored?.models
				.filter((model) => isModelType(model, "chat"))
				.map((model) => ({
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					thinkingLevelMap: model.thinkingLevelMap,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}));
			const current = storedModels?.length ? storedModels : staticModels;
			const checkedAt = context.stored?.checkedAt ?? 0;
			if (
				!context.allowNetwork ||
				(!context.force && Date.now() - checkedAt < MODEL_CATALOG_TTL_MS) ||
				context.credential?.type !== "oauth"
			) {
				return current;
			}

			const project = context.credential.refresh.split("|")[1];
			if (!project) throw new Error("Antigravity credentials have no project id. Run /login again.");
			const refreshed = toProviderModels(await refreshModelCatalog(context.credential.access, project, context.signal));
			await context.publish({
				persist: {
					checkedAt: Date.now(),
					models: refreshed.map((model) => ({
						...model,
						api: "google-generative-ai",
						provider: PROVIDER_ID,
						baseUrl: "https://cloudcode-pa.googleapis.com",
					})),
				},
			});
			return refreshed;
		},
		oauth: {
			name: "Google Antigravity",
			isSubscription: true,
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
