# pi-footer

A Pi footer and `/footer` command for token metrics, output speed, and provider quotas.

## Metrics

- Input, output, cache read, cache write, and total tokens
- Cost, marked `(sub)` when the current provider is subscription-backed
- Context-window usage
- Cache hit rate of the latest assistant message
- Output speed of the latest assistant message

The second line shows the working directory, git branch, session name, and extension statuses.

Configuration is stored as `pi-footer.json` in the Pi agent directory. Use `/footer` to toggle items, pick the context and speed styles, and set the quota refresh interval. The extension does not persist usage logs.

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

Based on `token-stats-timer` 1.1.8 at commit `9997f89e31086d4788f368624b2f269d5155bc02`. The Anthropic, OpenAI Codex, xAI, and Google Antigravity quota providers are based on `pi-usage`.
