import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { InvalidCommandError, serializeWebRunPayload, validateWebRunCommand, type WebRunCommand } from "./commands.ts";
import {
	CodexAuthExpiredError,
	CodexAuthMissingError,
	CodexHttpError,
	CodexRateLimitError,
	WebSearchCancelledError,
	WebSearchTimeoutError,
} from "./errors.ts";
import { normalizeSearchResponseBody, type SearchResponse } from "./normalize.ts";
import type { RefIndex, SearchExecutionOptions, SearchRequest, WebSearchProvider } from "./provider.ts";

const PROVIDER_ID = "openai-codex";

export interface OpenAiAuthCredentials {
	accessToken: string;
	accountId?: string;
}

function readStoredOAuthCredential(): { access: string; accountId?: string } | undefined {
	const credential = readStoredCredential(PROVIDER_ID);
	if (!credential || credential.type !== "oauth") return undefined;
	const accountId = typeof credential.accountId === "string" && credential.accountId ? credential.accountId : undefined;
	return { access: credential.access, accountId };
}

async function resolveOpenAiAuth(ctx: ExtensionContext): Promise<OpenAiAuthCredentials | null> {
	// Prefer the auto-refreshed OAuth token from pi's model registry.
	let accessToken: string | undefined;
	try {
		const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
		const headerAuth = resolved?.auth.headers?.["Authorization"];
		accessToken =
			resolved?.auth.apiKey ?? (typeof headerAuth === "string" ? headerAuth.replace(/^Bearer\s+/i, "") : undefined);
	} catch {
		accessToken = undefined;
	}

	const stored = readStoredOAuthCredential();
	const token = accessToken ?? stored?.access;
	if (!token) return null;
	return { accessToken: token, accountId: stored?.accountId };
}

export interface CodexWebSearchProviderOptions {
	endpoint?: string;
	timeoutMs?: number;
	customFetch?: typeof fetch;
	sessionId?: string;
	model?: string;
	maxRetries?: number;
}

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = "gpt-4o";

export class CodexWebSearchProvider implements WebSearchProvider {
	private endpoint: string;
	private timeoutMs: number;
	private fetchImpl: typeof fetch;
	private currentSessionId: string;
	private model: string;
	private maxRetries: number;
	private refIndex: RefIndex = new Map();

	constructor(options?: CodexWebSearchProviderOptions) {
		this.endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options?.customFetch ?? globalThis.fetch;
		this.model = options?.model ?? DEFAULT_MODEL;
		this.maxRetries = options?.maxRetries ?? 2;
		this.currentSessionId = options?.sessionId ?? `search_session_${Math.random().toString(36).substring(2, 10)}`;
	}

	getRefIndex(): RefIndex {
		return this.refIndex;
	}

	getSessionId(): string {
		return this.currentSessionId;
	}

	setSessionId(id: string): void {
		if (id && id.trim()) {
			if (id.trim() !== this.currentSessionId) {
				this.refIndex.clear();
			}
			this.currentSessionId = id.trim();
		}
	}

	private recordRefs(response: SearchResponse): void {
		for (const r of response.results) {
			const ref = r.ref_id;
			if (!ref || !r.url) continue;
			const existing = this.refIndex.get(ref);
			this.refIndex.set(ref, { url: r.url, title: r.title ?? existing?.title });
		}
	}

	async search(request: SearchRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResponse> {
		const command: WebRunCommand = {
			search_query: [{ q: request.query }],
		};
		return this.execute(command, undefined, ctx, signal);
	}

	async execute(
		command: WebRunCommand,
		options: SearchExecutionOptions | undefined,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<SearchResponse> {
		const validatedCmd = validateWebRunCommand(command);

		// Document refs are only resolvable while the backend session and this process's
		// ref index agree; fail fast with guidance instead of an opaque HTTP error.
		for (const operation of [
			...(validatedCmd.open ?? []),
			...(validatedCmd.click ?? []),
			...(validatedCmd.find ?? []),
		]) {
			if (!this.refIndex.has(operation.ref_id)) {
				throw new InvalidCommandError(
					`Unknown or stale reference "${operation.ref_id}". Run a new search_query first.`,
				);
			}
		}

		const auth = await resolveOpenAiAuth(ctx);
		if (!auth) {
			throw new CodexAuthMissingError();
		}

		const controller = new AbortController();
		const onAbort = () => controller.abort();

		if (signal?.aborted) {
			throw new WebSearchCancelledError();
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		const timeoutId = setTimeout(() => controller.abort("timeout"), this.timeoutMs);

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": "codex-cli/0.147.0-alpha.6.5",
		};
		if (auth.accountId) {
			headers["ChatGPT-Account-ID"] = auth.accountId;
		}

		const sessionId = options?.sessionId ?? this.currentSessionId;

		const payload = serializeWebRunPayload(validatedCmd, {
			sessionId,
			model: this.model,
		});

		const startTime = Date.now();
		const requestId = Math.random().toString(36).substring(2, 9);

		if (process.env.PI_WEB_SEARCH_DEBUG) {
			console.error(
				`[PI_WEB_SEARCH_DEBUG] req_id=${requestId} session_id=${sessionId} cmd=${JSON.stringify(
					validatedCmd,
				)} provider=codex`,
			);
		}

		try {
			let response: Response | null = null;
			let attempt = 0;

			while (attempt <= this.maxRetries) {
				attempt++;
				response = await this.fetchImpl(this.endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: controller.signal,
				});

				if (response.status === 502 || response.status === 503 || response.status === 504) {
					if (attempt <= this.maxRetries) {
						await response.body?.cancel().catch(() => {});
						await new Promise((res) => setTimeout(res, 500 * attempt));
						continue;
					}
				}
				break;
			}

			if (!response) {
				throw new CodexHttpError(500, "No response received");
			}

			const elapsedMs = Date.now() - startTime;

			if (response.status === 401 || response.status === 403) {
				if (process.env.PI_WEB_SEARCH_DEBUG) {
					console.error(`[PI_WEB_SEARCH_DEBUG] req_id=${requestId} status=${response.status} auth_failed`);
				}
				throw new CodexAuthExpiredError();
			}

			if (response.status === 429) {
				if (process.env.PI_WEB_SEARCH_DEBUG) {
					console.error(`[PI_WEB_SEARCH_DEBUG] req_id=${requestId} status=429 rate_limited`);
				}
				throw new CodexRateLimitError();
			}

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				if (process.env.PI_WEB_SEARCH_DEBUG) {
					console.error(`[PI_WEB_SEARCH_DEBUG] req_id=${requestId} status=${response.status} error="${text}"`);
				}
				throw new CodexHttpError(response.status, text.slice(0, 200));
			}

			const body = await response.json();
			const normalized = normalizeSearchResponseBody(body);
			this.recordRefs(normalized);

			if (process.env.PI_WEB_SEARCH_DEBUG) {
				console.error(
					`[PI_WEB_SEARCH_DEBUG] req_id=${requestId} status=200 elapsed_ms=${elapsedMs} results=${normalized.results.length} output_len=${normalized.output?.length ?? 0}`,
				);
			}

			return normalized;
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") {
				if (controller.signal.reason === "timeout") {
					throw new WebSearchTimeoutError(this.timeoutMs);
				}
				throw new WebSearchCancelledError();
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
