# pi-anthropic-oauth

Claude Code request fingerprint for Pi's built-in `anthropic` provider. Registers `streamSimple` for `api anthropic-messages`; login and token refresh use Pi's built-in Anthropic OAuth (`/login`, Claude Pro/Max).

## Provider

For OAuth tokens (`sk-ant-oat`), `streamSimple` sends the Claude Code request fingerprint (User-Agent, full beta list, session/request IDs, `metadata.user_id` from `~/.claude.json`, billing system block, `context_management` except on payloads with a `compaction` parameter, which the API rejects together with it, `diagnostics`) with a computed `cch` attestation (see `CCH.md`). API-key requests pass through unchanged.
