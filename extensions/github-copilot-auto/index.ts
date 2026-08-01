import {
	type Api,
	type Context,
	lazyStream,
	type Model,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "github-copilot";
const AUTO_MODEL_ID = "auto";
const AUTO_PREFIX = "auto-";

// Minimum interval before re-fetching the built-in Copilot catalog during model refresh.
// Startup refresh must stay off the network or the TUI freezes until it completes.
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

function realModelId(id: string): string {
	return id.startsWith(AUTO_PREFIX) ? id.slice(AUTO_PREFIX.length) : id;
}
const COPILOT_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/json",
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": "2026-06-01",
	"Openai-Intent": "conversation-edits",
} as const;

const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

interface AutoSession {
	availableModels: string[];
	sessionToken: string;
	expiresAt: number;
	interactionId: string;
	chosenModel?: string;
	reasoningBucket?: "low" | "medium" | "high";
}

interface SessionResponse {
	available_models?: unknown;
	selected_model?: unknown;
	session_token?: unknown;
	expires_at?: unknown;
}

interface IntentResponse {
	chosen_model?: unknown;
	candidate_models?: unknown;
	reasoning_bucket?: unknown;
}

function apiForModel(id: string): Api {
	if (/^claude-(haiku|sonnet|opus)-[45]([.\-]|$)/.test(id)) return "anthropic-messages";
	if (id.startsWith("gpt-5") || id.startsWith("oswe") || id.startsWith("mai-")) return "openai-responses";
	return "openai-completions";
}

function poolModel(id: string, name: string, api: Api): Model<Api> {
	const anthropic = api === "anthropic-messages";
	const responses = api === "openai-responses";
	let compat: Record<string, unknown>;
	if (anthropic) {
		compat = { supportsEagerToolInputStreaming: false };
	} else if (responses) {
		compat = {
			supportsReasoningEffort: true,
			supportsStore: false,
			supportsStrictMode: true,
			sessionAffinityFormat: "openai",
		};
	} else {
		compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}
	return {
		id,
		name,
		api,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: responses,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: anthropic ? 64_000 : 128_000,
		thinkingLevelMap: responses
			? {
					off: "none",
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: null,
					max: null,
				}
			: undefined,
		compat,
	};
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function latestUserPrompt(context: Context): { prompt: string; hasImage: boolean } {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return { prompt: message.content, hasImage: false };

		let prompt = "";
		let hasImage = false;
		for (const part of message.content) {
			if (part.type === "text") prompt += `${prompt ? "\n" : ""}${part.text}`;
			if (part.type === "image") hasImage = true;
		}
		return { prompt, hasImage };
	}
	return { prompt: "", hasImage: false };
}

function mergeHeaders(base: ProviderHeaders | undefined, extra: Record<string, string>): ProviderHeaders {
	const merged: ProviderHeaders = { ...(base ?? {}) };
	for (const [name, value] of Object.entries(extra)) {
		for (const existing of Object.keys(merged)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
		}
		merged[name] = value;
	}
	return merged;
}

async function credentialFingerprint(apiKey: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
	return Array.from(new Uint8Array(digest, 0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(15_000);
	const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, { ...init, signal: combinedSignal });
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Copilot Auto ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
	}
	return (await response.json()) as T;
}

async function createAutoSession(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<AutoSession> {
	const interactionId = crypto.randomUUID();
	const response = await fetchJson<SessionResponse>(
		`${baseUrl}/models/session`,
		{
			method: "POST",
			headers: {
				...COPILOT_HEADERS,
				Authorization: `Bearer ${apiKey}`,
				"X-Initiator": "user",
				"X-Interaction-Id": interactionId,
			},
			body: JSON.stringify({ auto_mode: { model_hints: [AUTO_MODEL_ID] } }),
		},
		signal,
	);

	const availableModels = stringList(response.available_models);
	if (availableModels.length === 0 || typeof response.session_token !== "string") {
		throw new Error("Copilot Auto returned an invalid model session");
	}

	const now = Date.now();
	const reportedExpiry = typeof response.expires_at === "number" ? response.expires_at * 1000 : 0;
	const expiresAt =
		reportedExpiry > now + 30_000 && reportedExpiry < now + 24 * 60 * 60_000 ? reportedExpiry : now + 10 * 60_000;
	return {
		availableModels,
		sessionToken: response.session_token,
		expiresAt,
		interactionId,
		chosenModel: typeof response.selected_model === "string" ? response.selected_model : availableModels[0],
	};
}

async function routePrompt(
	baseUrl: string,
	apiKey: string,
	state: AutoSession,
	context: Context,
	signal?: AbortSignal,
): Promise<void> {
	const { prompt, hasImage } = latestUserPrompt(context);
	const response = await fetchJson<IntentResponse>(
		`${baseUrl}/models/session/intent`,
		{
			method: "POST",
			headers: {
				...COPILOT_HEADERS,
				Authorization: `Bearer ${apiKey}`,
				"Copilot-Session-Token": state.sessionToken,
				"X-Initiator": "user",
				"X-Interaction-Id": state.interactionId,
			},
			body: JSON.stringify({ prompt, available_models: state.availableModels, has_image: hasImage }),
		},
		signal,
	);

	const candidates = stringList(response.candidate_models);
	const chosen = typeof response.chosen_model === "string" ? response.chosen_model : candidates[0];
	if (!chosen) throw new Error("Copilot Auto router did not choose a model");

	state.chosenModel = chosen;
	const bucket = response.reasoning_bucket;
	state.reasoningBucket = bucket === "low" || bucket === "medium" || bucket === "high" ? bucket : undefined;
}

function wrapProvider(base: Provider, pool: string[], onBaseRefreshed?: () => void): Provider {
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
			if (sessions.size > 32) sessions.delete(sessions.keys().next().value!);
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

	return {
		...base,
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
			const stored = await context.store.read();
			const checkedAt = stored?.checkedAt;
			const fresh = checkedAt !== undefined && Date.now() - checkedAt < REFRESH_TTL_MS;
			if (context.allowNetwork && (context.force || !fresh)) {
				// Detached: pi awaits refreshModels during startup, so network work here
				// must not block. Re-register once the refreshed catalog lands.
				void (async () => {
					try {
						await base.refreshModels?.(context);
						await context.store.write({ models: listModels(), checkedAt: Date.now() });
					} catch {
						return;
					}
					onBaseRefreshed?.();
				})();
			}
			// pi-coding-agent publishes the returned list through the composed provider;
			// pi-ai's Provider type declares Promise<void>.
			return listModels() as unknown as void;
		},
	};
}

export default function githubCopilotAuto(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const base = ctx.modelRegistry.getProvider(PROVIDER_ID);
		if (!base || base.getModels().some((entry) => entry.id === AUTO_MODEL_ID)) return;

		let pool: string[] = [];
		const register = () => {
			const latest = ctx.modelRegistry.getProvider(PROVIDER_ID);
			const source = latest && !latest.getModels().some((model) => model.id === AUTO_MODEL_ID) ? latest : base;
			pi.registerProvider(wrapProvider(source, pool, register));
		};
		register();

		void (async () => {
			try {
				const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
				const apiKey = resolved?.auth.apiKey;
				const baseUrl = resolved?.auth.baseUrl ?? base.baseUrl ?? DEFAULT_BASE_URL;
				if (!apiKey) return;
				const { availableModels } = await createAutoSession(baseUrl, apiKey);
				if (availableModels.length > 0) {
					pool = availableModels;
					register();
				}
			} catch {}
		})();
	});
}
