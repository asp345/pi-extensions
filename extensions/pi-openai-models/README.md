# pi-openai-models

OpenAI model settings for pi. The extension wraps both `openai` and `openai-codex`, preserves their base catalogs, adds optional model aliases, and applies supported service tiers to each provider.

## Command

```
/openai
```

The interactive settings menu controls:

- **Context window**: Enter toggles between `standard` and `1m`. `standard` preserves the provider catalog limits; `1m` sets supported GPT models to `1_050_000` tokens.
- **Daybreak Blue**: Enter toggles it `on` or `off`. It is enabled by default and adds `gpt-daybreak-blue-latest` to both OpenAI provider catalogs.
- **Service tier**: Enter opens the `default`, `flex (API only)`, and `priority` selection. Flex is sent through direct OpenAI API providers only. It is not sent through `openai-codex-responses`.

Settings are stored in `openai-models.json` in the pi agent directory. Defaults are `1m`, Daybreak Blue `on`, and service tier `default`.

## Models

The extension always adds the `gpt-5.6` alias when it is absent. Daybreak Blue support adds `gpt-daybreak-blue-latest`. Both aliases inherit provider-specific metadata from `gpt-5.6-sol`, including API type, endpoint, costs, thinking levels, capabilities, and image support. Consequently, the Codex entries use `openai-codex-responses` and `https://chatgpt.com/backend-api`, while direct OpenAI entries use the direct API metadata.

When 1M mode is enabled, these model IDs use a `1_050_000` token context window when present:

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-daybreak-blue-latest`

Existing pricing tiers are preserved. Switching to `standard` restores the base provider context windows.

Daybreak Red, GPT-5.6 Cyber, and legacy GPT-5.5 Cyber are not added.

Daybreak Blue still requires OpenAI approval and the required account or project configuration. Showing the model in pi does not grant access.

## Service tiers

- `default`: no explicit `service_tier`
- `flex (API only)`: `service_tier: "flex"` for direct OpenAI API requests; Codex uses default processing
- `priority`: `service_tier: "priority"`

Pi's Responses adapters calculate service-tier costs. The Chat Completions path applies multipliers of `0.5` for Flex and `2` for Priority, except GPT-5.5 Priority uses `2.5`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Provider wrapping and `/openai` settings menu |
| `models.ts` | Context overlays and optional aliases |
| `settings.ts` | Persistent OpenAI settings |
| `tier.ts` | Service-tier payload and cost logic |
| `*.test.ts` | Unit and wrapper tests |

## Sources

- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest
- https://help.openai.com/en/articles/20001259
