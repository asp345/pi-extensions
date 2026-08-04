# pi-usage

Adds a `/usage` slash command that fetches and displays current provider usage limits.

## Supported providers

- **Anthropic** — `GET https://api.anthropic.com/api/oauth/usage` with the Claude Code OAuth token. Reports 5-hour and 7-day windows, per-model-family weekly caps, and extra-usage spend.
- **OpenAI Codex** — `GET https://chatgpt.com/backend-api/wham/usage` with the Codex OAuth token. Reports primary and secondary chat windows and account plan type.
- **Google Antigravity** — `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` with the Antigravity OAuth token and project id. Reports daily and weekly quota windows per backend counter.
- **xAI (SuperGrok)** — `GET https://cli-chat-proxy.grok.com/v1/billing` with the Grok OAuth token. Reports weekly credit usage (`?format=credits`) and, for unified-billing accounts, monthly included quota with on-demand overage.

## Usage

```
/usage             # fetch all configured providers
/usage anthropic   # fetch a single provider
```

## Credential resolution

The extension resolves the OAuth access token through `ctx.modelRegistry.getProviderAuth`, which returns a fresh, auto-refreshed token. Account and project metadata that auth resolution does not surface (`accountId` for Codex, `projectId` for Antigravity, encoded in the stored refresh token) are read from `auth.json` via `getAgentDir()`.

Usage is fetched on demand only. No rate-limit headers are captured during normal model calls.
