# pi-custom-providers

Custom providers for the pi coding agent, configured with `/custom-providers`.

## Command

```
/custom-providers
```

The wizard writes provider connection and compatibility settings to `custom-providers.json`. It does not read or write `models.json`.

- **Providers** — add, edit, and remove providers; set base URL, API format, display name, and optional API key config.
- **Compatibility** — override developer-role support, `reasoning_effort` support, thinking request format, and the max-token field. Pi resolves compatibility per model, so provider-level settings are applied to every model of that provider and a model's own overrides take precedence.

Credentials are resolved through Pi. Configure them with `/login`, or store a `$ENV_VAR` reference in `custom-providers.json`.

## Runtime behavior

Configured providers are registered when the extension loads. Opening `/model` or `/models` asks Pi to refresh their catalogs, and repeated requests within 24 hours reuse the cached result. `pi update --models` does not load extensions and therefore cannot refresh these custom providers.

A network refresh reads the provider's complete model list and publishes every discovered model with its endpoint-specific context window, output limit, reasoning support, thinking levels, image input, and pricing. No shared catalog is consulted because those capabilities describe the serving endpoint.

Capability lists are read from `features`, `supported_features`, `tags`, `capabilities`, and `supported_parameters`, since providers spell the same field differently.

Offline refreshes make no requests. They reuse the catalog Pi persisted in `models-store.json` after the last successful network refresh. Catalog entries older than thirty days are deleted.

Pi composes the discovered catalog with `models.json` independently. Entries under `models` remain available as manually added models, including IDs absent from the provider listing. Entries under `modelOverrides` modify matching discovered models.

Listings quote prices in several dialects. OpenRouter reports a per-token price as a string, crof reports dollars per million tokens, and Novita nests a `price_per_m` counted in units of 1e-4 USD per million tokens. Auto-detection selects a multiplier that produces $0.001–$100 per million tokens; **Connection → Price multiplier** accepts a fixed override.

System prompts are sent with the `system` role. Pi reads an unknown OpenAI-compatible endpoint as speaking OpenAI's role vocabulary and would otherwise send a `developer` message for every reasoning model, which most gateways reject with a bare 400. The two roles reach the same level of pi's instruction hierarchy on endpoints that accept either name, so `system` is the portable choice. Set `Developer role: Yes` for an endpoint that requires `developer`.

Providers Pi ships itself are left untouched. Use `/models` to change which models Pi cycles through and edit `models.json` directly for manual models or metadata overrides.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: provider registration and `/custom-providers` |
| `ui.ts` | Wizard dialogs |
| `discovery.ts` | Provider catalog and metadata parsing |
| `runtime.ts` | Automatic provider catalog registration and refresh |
| `config.ts` | Atomic `custom-providers.json` persistence and catalog cleanup |
| `*.test.ts` | Unit tests for parsing, persistence, registration, and refresh |
| `types.ts` | Configuration types and defaults |
