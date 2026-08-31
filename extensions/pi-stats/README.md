# pi-stats

A single Pi footer and `/stats` command for token metrics, timing, persisted summaries, and provider quotas.

## Metrics

- Input, output, and total tokens
- Cost
- Context-window usage
- Cache hit rate
- Average and rolling token throughput
- First-token latency
- Current task and run duration

Statistics are stored under the Pi agent directory at `extensions/pi-stats/logs/`. Use `/stats` with `day`, `hour`, `week`, or `month` to inspect summaries. Use `/stats config` to configure the footer.

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
