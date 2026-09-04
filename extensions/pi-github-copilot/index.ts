import {
	type Api,
	type Context,
	lazyStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutoSession,
	COPILOT_HEADERS,
	createAutoSession,
	credentialFingerprint,
	mergeHeaders,
	routePrompt,
} from "./auto-session.ts";
import {
	AUTO_MODEL_ID,
	AUTO_PREFIX,
	apiForModel,
	BASE_PROVIDER,
	DEFAULT_BASE_URL,
	PROVIDER_ID,
	poolModel,
	realModelId,
	type WrappedProvider,
} from "./catalog.ts";

export { apiForModel, poolModel, realModelId } from "./catalog.ts";

// Minimum interval before re-fetching the built-in Copilot catalog during model refresh.
// Startup refresh must stay off the network or the TUI freezes until it completes.
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

export function wrapProvider(base: Provider, pool: string[], onBaseRefreshed?: () => void): Provider {
	const baseById = new Map(base.getModels().map((entry) => [entry.id, entry]));

	const templateFor = (realId: string, displayId: string): Model<Api> => {
		const known = baseById.get(realId);
		if (known) return { ...known, id: displayId, name: displayId };
		return poolModel(displayId, displayId, apiForModel(realId));
	};

	const routerModel = poolModel(AUTO_MODEL_ID, "Copilot Auto", "openai-responses");
	const poolIds = new Set(pool);
	const managedIds = new Set([AUTO_MODEL_ID, ...pool.map((id) => `${AUTO_PREFIX}${id}`)]);
	const poolModels = pool.map((id) => templateFor(id, `${AUTO_PREFIX}${id}`));
	const sessions = new Map<string, AutoSession>();

	async function prepare(
		requestModel: Model<Api>,
		context: Context,
		options: StreamOptions | undefined,
	): Promise<{ model: Model<Api>; options: SimpleStreamOptions }> {
		const apiKey = options?.apiKey;
		if (!apiKey) throw new Error("GitHub Copilot authentication is unavailable");

		const realId = realModelId(requestModel.id);
		const forced = poolIds.has(realId) ? realId : undefined;
		const baseUrl = requestModel.baseUrl ?? base.baseUrl ?? routerModel.baseUrl ?? DEFAULT_BASE_URL;

		const fingerprint = await credentialFingerprint(apiKey);
		const key = `${baseUrl}|${fingerprint}|${forced ?? "auto"}|${options?.sessionId ?? "default"}`;
		let state = sessions.get(key);
		if (!state || state.expiresAt <= Date.now() + 30_000) {
			state = await createAutoSession(baseUrl, apiKey, options?.signal);
			sessions.set(key, state);
			if (sessions.size > 32) {
				const oldest = sessions.keys().next().value;
				if (oldest) sessions.delete(oldest);
			}
		}

		if (forced) {
			state.chosenModel = forced;
			state.reasoningBucket = undefined;
		} else {
			const lastMessage = context.messages.at(-1);
			if (!state.chosenModel || lastMessage?.role === "user") {
				await routePrompt(baseUrl, apiKey, state, context, options?.signal);
			}
		}
		if (!state.chosenModel) throw new Error("Copilot Auto did not select a model");

		const template = templateFor(state.chosenModel, state.chosenModel);
		return {
			model: { ...template, id: state.chosenModel, name: state.chosenModel, baseUrl },
			options: {
				...options,
				reasoning: state.reasoningBucket ?? (options as SimpleStreamOptions | undefined)?.reasoning,
				headers: mergeHeaders(options?.headers, {
					...COPILOT_HEADERS,
					"Copilot-Session-Token": state.sessionToken,
					"X-Interaction-Id": state.interactionId,
				}),
			},
		};
	}

	const streamAuto = (requestModel: Model<Api>, context: Context, options?: StreamOptions) =>
		lazyStream(requestModel, async () => {
			const routed = await prepare(requestModel, context, options);
			return base.streamSimple(routed.model, context, routed.options);
		});

	const listModels = (): Model<Api>[] => [
		routerModel,
		...poolModels,
		...base.getModels().filter((entry) => !managedIds.has(entry.id)),
	];

	const wrapped: WrappedProvider = {
		...base,
		[BASE_PROVIDER]: base,
		getModels: listModels,
		filterModels: (models, credential) => {
			const remaining = models.filter((entry) => !managedIds.has(entry.id));
			const filtered = base.filterModels?.(remaining, credential) ?? remaining;
			return [routerModel, ...poolModels, ...filtered];
		},
		stream: (requestModel, context, options) =>
			managedIds.has(requestModel.id)
				? streamAuto(requestModel, context, options)
				: base.stream(requestModel, context, options),
		streamSimple: (requestModel, context, options) =>
			managedIds.has(requestModel.id)
				? streamAuto(requestModel, context, options)
				: base.streamSimple(requestModel, context, options),
		refreshModels: async (context) => {
			const stored = context.stored;
			const checkedAt = stored?.checkedAt;
			const fresh = checkedAt !== undefined && Date.now() - checkedAt < REFRESH_TTL_MS;
			if (context.allowNetwork && (context.force || !fresh)) {
				// Detached: pi awaits refreshModels during startup, so network work here
				// must not block. Re-register once the refreshed catalog lands.
				void (async () => {
					try {
						await base.refreshModels?.(context);
						await context.publish({
							persist: {
								models: listModels(),
								checkedAt: Date.now(),
							},
						});
						onBaseRefreshed?.();
					} catch {}
				})();
			}
			// pi-coding-agent publishes the returned list through the composed provider;
			// pi-ai's Provider type declares Promise<void>.
			return listModels() as unknown as undefined;
		},
	};
	return wrapped;
}

export default function githubCopilotAuto(pi: ExtensionAPI) {
	let generation = 0;
	pi.on("session_start", (_event, ctx) => {
		const activeGeneration = ++generation;
		const current = ctx.modelRegistry.getProvider(PROVIDER_ID) as WrappedProvider | undefined;
		const base = current?.[BASE_PROVIDER] ?? current;
		if (!base) return;

		let pool = base.getModels().flatMap((model) => (model.id.startsWith(AUTO_PREFIX) ? [realModelId(model.id)] : []));
		const register = () => {
			if (generation !== activeGeneration) return;
			// ModelRuntime composition intentionally copies only Provider fields, so
			// re-reading the registered provider loses BASE_PROVIDER and would wrap
			// the previous wrapper again. Always rebuild from this session's stable base.
			pi.registerProvider(wrapProvider(base, pool, register));
		};
		register();

		void (async () => {
			try {
				const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
				const apiKey = resolved?.auth.apiKey;
				const baseUrl = resolved?.auth.baseUrl ?? base.baseUrl ?? DEFAULT_BASE_URL;
				if (!apiKey) return;
				const { availableModels } = await createAutoSession(baseUrl, apiKey);
				if (generation === activeGeneration && availableModels.length > 0) {
					pool = availableModels;
					register();
				}
			} catch {}
		})();
	});
	pi.on("session_shutdown", () => {
		generation += 1;
		pi.unregisterProvider(PROVIDER_ID);
	});
}
