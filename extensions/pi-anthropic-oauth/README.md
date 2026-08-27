# pi-anthropic-oauth

Anthropic OAuth provider for Pi. Registers `anthropic` with `api anthropic-messages` and handles Claude Pro/Max login via OAuth PKCE.

## Flow

* `CLIENT_ID 9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `https://claude.ai/oauth/authorize`, `https://platform.claude.com/v1/oauth/token`
* PKCE `S256`, state token, local callback `http://localhost:53692/callback` with fallback to `https://platform.claude.com/oauth/code/callback`
* Token retry on `429`/`5xx` with `Retry-After`, refresh with `grant_type refresh_token`

## System prompt

`rewriteSystemPrompt` strips `you are pi` / `pi-coding-agent` paragraphs and rewrites standalone `Pi` to `Claude Code`.

## Provider

`getApiKey` returns `credentials.access`, `streamSimple` delegates to `anthropicMessagesApi().streamSimple` with rewritten system prompt.
