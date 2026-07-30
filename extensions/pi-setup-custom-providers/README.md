# pi-setup-custom-providers

Custom model providers for the pi coding agent, configured with `/custom-model`.

## Command

```
/custom-model
```

The wizard uses pi's standard dialogs and writes every change to pi's `models.json` immediately.

- **Providers** — add, edit, and remove providers; set base URL, API format, display name, and optional API key config.
- **Models** — add and remove models; edit display name, reasoning support, image input, context window, and output limit.
- **Discovery** — read the provider's model list, then refresh metadata for configured models, add all new models, or add them one at a time.
- **Thinking** — map each pi thinking level to the value the provider expects, or mark it unsupported. The extension never changes the active thinking level; pi owns that, and it re-clamps the level to the model's supported set on every switch.
- **Compatibility** — override developer-role support, `reasoning_effort` support, thinking request format, and the max-token field. Pi resolves compatibility per model, so provider-level settings are applied to every model of that provider and a model's own overrides take precedence.

Credentials are resolved through pi. Configure them with `/login`, or store a `$ENV_VAR` reference in the provider's API key field.

## Runtime behavior

Configured providers are registered when the extension loads, so their models appear in `/model` and `pi --list-models`. Each provider supplies a `refreshModels` callback, so pi refreshes metadata on session start, when `/model` opens, and on `pi update --models`.

A refresh reads the provider's own model list and takes every field from it: context window, output limit, reasoning support, thinking levels, image input, and pricing. No shared catalog is consulted, because capabilities, effort names, and prices describe the serving endpoint rather than the model, and a listing for some other gateway would claim support this endpoint may not have. Requests are bounded by a timeout, repeats within five minutes reuse the previous result, and a failed discovery keeps the configured list.

Capability lists are read from `features`, `supported_features`, `tags`, `capabilities`, and `supported_parameters`, since providers spell the same field differently.

Offline refreshes make no requests. They reuse the catalog pi persisted for the provider after its last networked refresh, so metadata is available at startup.

A persisted catalog outranks the configured metadata it was derived from, so one that is unreadable, undated, or older than thirty days is deleted instead of merged, and the configured values are used until the next networked refresh writes a fresh catalog.

Refresh only widens what is configured. Names, reasoning flags, and thinking maps set by hand are never overwritten, and models marked `manual` keep their limits. Pricing has no manual field and is always taken from the newest listing, so stale or zeroed rates are corrected by a refresh.

Listings quote prices in two dialects. OpenRouter reports a per-token price as a string, Novita nests a `price_per_m` counted in units of 1e-4 USD per million tokens. Both are normalized to pi's USD-per-million convention.

System prompts are sent with the `system` role. Pi reads an unknown OpenAI-compatible endpoint as speaking OpenAI's role vocabulary and would otherwise send a `developer` message for every reasoning model, which most gateways reject with a bare 400. The two roles reach the same level of pi's instruction hierarchy on endpoints that accept either name, so `system` is the portable choice. Set `Developer role: Yes` for an endpoint that requires `developer`.

Providers pi ships itself are left untouched, and the extension never writes `settings.json`. Use `/models` if you want to change which models pi cycles through.

Thinking level maps come from the provider's listing (`reasoning.supported_efforts`) or from the values set by hand under **Thinking**. Without a map, pi offers `off` through `high`; `xhigh` and `max` require an explicit entry.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: provider registration and `/custom-model` |
| `ui.ts` | Wizard dialogs |
| `discovery.ts` | Provider listings, OpenRouter catalog, metadata merge |
| `runtime.ts` | Provider registration and refresh |
| `config.ts` | Atomic `models.json` reads and writes |
| `*.test.ts` | Unit tests for parsing, merging, persistence, and refresh |
| `types.ts` | Configuration types and defaults |
