import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveOpenAiAuth } from "./auth.ts";
import { InvalidCommandError, validateWebRunCommand, type WebRunCommand } from "./commands.ts";
import { normalizeSearchResponseBody, type SearchResponse } from "./normalize.ts";
import type { RefIndex } from "./output.ts";

interface CodexWebSearchProviderOptions {
	customFetch?: typeof fetch;
	sessionId?: string;
}

const ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const TIMEOUT_MS = 15000;
const MODEL = "gpt-4o";

function debug(requestId: string, fields: string): void {
	if (process.env.PI_WEB_SEARCH_DEBUG) console.error(`[PI_WEB_SEARCH_DEBUG] req_id=${requestId} ${fields}`);
}

export class CodexWebSearchProvider {
	private fetchImpl: typeof fetch;
	private sessionId: string;
	private refIndex: RefIndex = new Map();

	constructor(options?: CodexWebSearchProviderOptions) {
		this.fetchImpl = options?.customFetch ?? globalThis.fetch;
		this.sessionId = options?.sessionId ?? `search_session_${Math.random().toString(36).substring(2, 10)}`;
	}

	getRefIndex(): RefIndex {
		return this.refIndex;
	}

	// Groups indexed ids by their kind prefix (turn0search, turn2view, ...) into
	// "prefix<min>-<max> (<count>)" ranges so a model that guessed an id can pick a
	// valid one without another failing request.
	private knownRefsSummary(): string {
		if (!this.refIndex.size) return "none indexed yet";
		const indexesByPrefix = new Map<string, Set<number>>();
		for (const id of this.refIndex.keys()) {
			const match = /^(.*?)(\d+)$/u.exec(id);
			if (!match) continue;
			const set = indexesByPrefix.get(match[1]) ?? new Set<number>();
			set.add(Number(match[2]));
			indexesByPrefix.set(match[1], set);
		}
		return [...indexesByPrefix.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([prefix, indexes]) => {
				const ordered = [...indexes].sort((a, b) => a - b);
				const span =
					ordered.length === 1 ? `${ordered[0]}` : `${ordered[0]}-${ordered[ordered.length - 1]} (${ordered.length})`;
				return `${prefix}${span}`;
			})
			.join(", ");
	}

	private recordRefs(response: SearchResponse): void {
		for (const r of response.results) {
			const ref = r.ref_id;
			if (!ref || !r.url) continue;
			const existing = this.refIndex.get(ref);
			this.refIndex.set(ref, { url: r.url, title: r.title ?? existing?.title });
		}
	}

	async execute(command: WebRunCommand, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResponse> {
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
					`Unknown or stale reference "${operation.ref_id}"; known refs: ${this.knownRefsSummary()}. Run a new search_query first.`,
				);
			}
		}

		const auth = await resolveOpenAiAuth(ctx);
		if (!auth) {
			throw new Error(
				"ChatGPT web search is unavailable because the OpenAI Codex subscription is not authenticated. Run /login and select 'ChatGPT Plus/Pro (Codex)'.",
			);
		}

		if (signal?.aborted) throw new Error("Web search request was cancelled");
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeoutId = setTimeout(() => controller.abort("timeout"), TIMEOUT_MS);

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": "codex-cli/0.147.0-alpha.6.5",
		};
		if (auth.accountId) {
			headers["ChatGPT-Account-ID"] = auth.accountId;
		}

		const payload = { id: this.sessionId, model: MODEL, commands: validatedCmd };
		const startTime = Date.now();
		const requestId = Math.random().toString(36).substring(2, 9);
		debug(requestId, `session_id=${this.sessionId} cmd=${JSON.stringify(validatedCmd)} provider=codex`);

		try {
			const response = await this.fetchImpl(ENDPOINT, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			const elapsedMs = Date.now() - startTime;

			if (response.status === 401 || response.status === 403) {
				debug(requestId, `status=${response.status} auth_failed`);
				throw new Error(
					"ChatGPT authentication expired or unauthorized. Run /login and select 'ChatGPT Plus/Pro (Codex)' to re-authenticate.",
				);
			}
			if (response.status === 429) {
				debug(requestId, "status=429 rate_limited");
				throw new Error("Codex web search rate limit exceeded. Please wait before retrying.");
			}
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				debug(requestId, `status=${response.status} error="${text}"`);
				throw new Error(`Codex search HTTP ${response.status}: ${text.slice(0, 200)}`);
			}

			const normalized = normalizeSearchResponseBody(await response.json());
			this.recordRefs(normalized);
			debug(
				requestId,
				`status=200 elapsed_ms=${elapsedMs} results=${normalized.results.length} output_len=${normalized.output?.length ?? 0}`,
			);
			return normalized;
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") {
				if (controller.signal.reason === "timeout") {
					throw new Error(`Web search request timed out after ${TIMEOUT_MS}ms`);
				}
				throw new Error("Web search request was cancelled");
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
