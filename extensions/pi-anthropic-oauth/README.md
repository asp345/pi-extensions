# pi-anthropic-oauth

Claude Code request fingerprint for Pi's built-in `anthropic` provider. Registers `streamSimple` for `api anthropic-messages`; login and token refresh use Pi's built-in Anthropic OAuth (`/login`, Claude Pro/Max).

## Provider

For OAuth tokens (`sk-ant-oat`), `streamSimple` sends the Claude Code request fingerprint (User-Agent, full beta list, session/request IDs, `metadata.user_id` from `~/.claude.json`, billing system block, `context_management` except on payloads with a `compaction` parameter, which the API rejects together with it, `diagnostics`) with a computed `cch` attestation (see `CCH.md`). `anthropic-beta` entries passed by the caller, such as `compact-2026-09-04` from `pi-compaction`, are appended to the Claude Code beta list without duplicates. API-key requests pass through unchanged.

## Prompt cache

With `cacheTtl` set to `"5m"`, OAuth requests use pi-ai's default retention, which sends `cache_control: {"type": "ephemeral"}` (5-minute TTL), and Pi's `cacheWarming` setting refreshes the cache.

With `cacheTtl` set to `"1h"`, OAuth requests that do not set `cacheRetention` use `cacheRetention: "long"`, which sends `cache_control: {"type": "ephemeral", "ttl": "1h"}`. Requests that set `cacheRetention`, such as Pi's prompt-based compaction with `"none"`, keep their value. Pi's cache warmer derives the TTL from the request options before this provider runs, so it would assume 5 minutes; the extension returns `{ "action": "stop" }` from `cache_warming_decision` while the current model uses provider `anthropic` with an OAuth token.

## Configuration

The global configuration file is `pi-anthropic-oauth.json` in Pi's agent configuration directory. `PI_CODING_AGENT_DIR` determines that directory when set. A trusted project can override individual settings with `.pi/pi-anthropic-oauth.json`. Configuration is read at session start; use `/reload` to apply edits.

```json
{
  "cacheTtl": "5m"
}
```

`cacheTtl` defaults to `"5m"`. Accepted values are `"5m"` and `"1h"`.
