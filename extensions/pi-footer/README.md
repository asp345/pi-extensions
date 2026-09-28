# pi-footer

A Pi footer and `/footer` command for token metrics, timing, and provider quotas.

## Metrics

- Input, output, and total tokens
- Cost
- Context-window usage
- Cache hit rate
- Average and rolling token throughput

Configuration is stored as `pi-footer.json` in the Pi agent directory. Use `/footer config` to configure the footer. The extension does not persist usage logs.

## Provider quotas

Quota plans are selected automatically from the current provider ID. Supported providers:

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

Credentials are resolved in this order: the plan's environment variable (`MINIMAX_API_KEY`, `GLM_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`, `COMMANDCODE_API_KEY`), Pi's model registry, then Pi's `auth.json`. Anthropic, OpenAI Codex, xAI, and Google Antigravity use only the model registry and `auth.json`.

## Origin

Vendored from `token-stats-timer` 1.1.8 at commit `9997f89e31086d4788f368624b2f269d5155bc02`, then refactored for this repository. See `THIRD_PARTY_NOTICES.md`.
