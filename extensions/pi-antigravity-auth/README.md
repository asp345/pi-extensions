# pi-antigravity-auth

Google Antigravity authentication and transport for Pi. Registers `antigravity` with the agy CLI 1.2.16 wire identity.

## Components

* `oauth.ts` - OAuth for `https://oauth2.googleapis.com/token`; resolves the project via `loadCodeAssist` at login and stores it in the refresh credential
* `transport.ts` - Bun-native `fetchWithAgyCliTransport` with chunked requests and response timeouts
* `models.ts` - catalog refresh from `fetchAvailableModels` using `agentModelSorts` and `deprecatedModelIds`, `STATIC_MODEL_CATALOG`
* `model-resolver.ts` - `resolveModel` maps the `low|medium|high` thinking level to a catalog tier (wire model, `model_enum`, `thinkingBudget`, `thinkingLevel`)
* `request-metadata.ts` - `buildAgyAgentRequestMetadata` for `requestId`, `sessionId`, and labels
* `gemini.ts` - Gemini `contents`/`tools`/`systemInstruction` translation

## Sessions

`AgyRequestSessionStore` scopes requests by credential hash without exposing credential material.
