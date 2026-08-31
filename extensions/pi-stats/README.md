# pi-stats

A Pi footer and `/stats` command for token metrics, timing, and provider quotas.

## Metrics

- Input, output, and total tokens
- Cost
- Context-window usage
- Cache hit rate
- Average and rolling token throughput
- Current request duration in the working message

Configuration is stored as `pi-stats.json` in the Pi agent directory. Use `/stats config` to configure the footer. The extension does not persist usage logs.

## Provider quotas

Quota plans are selected automatically from the current provider ID. Use `/stats limit` only to override the detected plan or disable quota display. Supported providers:

- Anthropic Claude
- OpenAI Codex
- xAI
- Google Antigravity
- MiniMax
- GLM
- Kimi
- DeepSeek
- OpenCode Go
- Command Code

Credentials are resolved from provider environment variables or Pi's `auth.json`. OAuth-backed providers use Pi's model registry when available.

## Origin

Vendored from `token-stats-timer` 1.1.8 at commit `9997f89e31086d4788f368624b2f269d5155bc02`, then refactored for this repository. See `THIRD_PARTY_NOTICES.md`.
