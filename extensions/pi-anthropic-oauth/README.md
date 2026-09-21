# pi-anthropic-oauth

Anthropic OAuth provider for Pi. Registers `anthropic` with `api anthropic-messages` and handles Claude Pro/Max login via OAuth PKCE.

## Flow

* `CLIENT_ID 9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `https://claude.ai/oauth/authorize`, `https://platform.claude.com/v1/oauth/token`
* PKCE `S256`, state token, local callback `http://localhost:53692/callback` with fallback to `https://platform.claude.com/oauth/code/callback`
* Token retry on `429`/`5xx` with `Retry-After`, refresh with `grant_type refresh_token`

## Provider

`getApiKey` returns `credentials.access`. `streamSimple` sends the Claude Code request fingerprint (User-Agent, full beta list, session/request IDs, `metadata.user_id` from `~/.claude.json`, billing system block, `context_management`, `diagnostics`) with a computed `cch` attestation (see `CCH.md`), and passes API-key requests through unchanged.
