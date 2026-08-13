# How It Works: Technical Details

`pi-gpt-search` connects any active Pi coding agent model (Gemini, Claude, DeepSeek, local models via Ollama/Llama) with OpenAI Codex's standalone web search engine. The active model stays the only reasoning model; no GPT/Codex inference turn is billed.

## Data Flow

1. The active model calls `web({ search_query, open, click, find, response_length })` or `web_search({ query })`, or the user runs `/gpt-search <query>` (`index.ts`).
2. `web-tool.ts` wraps the call as a `WebRunCommand` and forwards it to `CodexWebSearchProvider` (`codex-provider.ts`).
3. `commands.ts` validates the command against the `WebRunCommandSchema` (the same TypeBox schema exposed to the model as tool parameters) and normalizes it.
4. The provider serializes the payload and POSTs it to `https://chatgpt.com/backend-api/codex/alpha/search`.
5. `normalize.ts` parses the response (`output`, `results` with `ref_id`/`url`/`title`/`snippet`); `output.ts` formats it for the model and the TUI.

## Transport Layer (`codex-provider.ts`)

- **Auth resolution:** the ChatGPT access token is resolved through `ctx.modelRegistry.getProviderAuth("openai-codex")` (pi's auto-refreshed OAuth token), with `accountId` read from pi's `auth.json` (`openai-codex.accountId`). `accountId` is sent as `ChatGPT-Account-ID` when present.
- **Session identity:** a stable `id` (`search_session_<random>` by default, overridable via `sessionId`) is sent on every call so reference IDs (`turn0search0`) stay valid across sequential `search` → `open` → `find` steps.
- **Resilience:** transient gateway errors (HTTP 502/503/504) are retried up to `maxRetries` (default 2) with linear backoff; 401/403 maps to `CodexAuthExpiredError`, 429 to `CodexRateLimitError`, other non-OK statuses to `CodexHttpError`.
- **Timeout and cancellation:** a `setTimeout` abort (`timeoutMs`, default 15000) and the caller's `AbortSignal` are bound to the `fetch` via one `AbortController`, so no request outlives its timeout or user `Esc`.
- **Debug logging:** with `PI_WEB_SEARCH_DEBUG=1`, each call logs `req_id`, session id, command, status, elapsed time, and result count to stderr.

## Error Hierarchy (`errors.ts`)

All errors extend `WebSearchError` with a stable `code`: `CODEX_AUTH_MISSING`, `CODEX_AUTH_EXPIRED`, `CODEX_RATE_LIMIT`, `CODEX_HTTP_ERROR`, `WEB_SEARCH_TIMEOUT`, `WEB_SEARCH_CANCELLED`.

## Output & Citation Engine (`output.ts`)

- The backend's model-oriented `output` text is passed to the active model verbatim as `content[0].text`.
- Private Unicode citation markers (`\uE200cite\uE202<ref>\uE201`) and raw turn references (`[turn0search0]`) are rewritten to numbered citations, clickable in the terminal via OSC 8 hyperlinks that resolve through the response's `ref_id` → URL map.
- A numbered `Sources:` index (title, `ref_id`, URL) is appended when the output lacks one; results-only responses are rendered as a numbered list instead.
- Raw results are attached to `details` only, so raw web payloads never enter the model's conversation context; the TUI uses `details` for the collapsed/expanded result row (`Ctrl+O`).

## Command Schema (`commands.ts`)

`WebRunCommandSchema` is the single source of truth for the command shape: `search_query` (multi-query with optional `recency` and `domains`), `open` (`ref_id`, optional `lineno`), `click` (`ref_id`, `id`), `find` (`ref_id`, `pattern`), and `response_length` (`short` | `medium` | `long`). `validateWebRunCommand` checks the value against the schema with TypeBox `Check`/`Errors` and then normalizes (trims identifiers, drops empty `domains`, rejects empty `q`/`ref_id`, requires at least one operation).
