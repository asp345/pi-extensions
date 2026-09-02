# pi-antigravity-auth

Google Antigravity (Gemini) authentication and transport for Pi. Registers `antigravity`.

## Components

* `agy/oauth.ts` - OAuth for `https://oauth2.googleapis.com/token`, project context enforcement
* `agy/transport.ts` - Bun-native `fetchWithAgyCliTransport` with chunked requests and response timeouts
* `agy/models.ts` - catalog refresh, `STATIC_MODEL_CATALOG`
* `agy/model-resolver.ts` - `resolveModel` maps `low|medium|high` suffix only
* `agy/request-metadata.ts` - `buildAgyAgentRequestMetadata` with fingerprint
* `index.ts` - Gemini `contents`/`tools`/`systemInstruction` translation, cost via `calculateCost`

## Sessions

`AgyRequestSessionStore` scopes requests by credential hash without exposing credential material.
