# pi-github-copilot

GitHub Copilot `auto` model routing for Pi. Registers `github-copilot`.

## Auto session

Uses `https://api.individual.githubcopilot.com` with `Copilot-Integration-Id: vscode-chat`, `Openai-Intent: conversation-edits`. `REFRESH_TTL_MS 24h` - startup stays off-network. `available_models` / `selected_model` / `session_token` cached with `expiresAt`, `interactionId`, `reasoningBucket low|medium|high`.

## Model mapping

`apiForModel` selects `anthropic-messages` for `claude-*`, `openai-responses` for `gpt-5*`, otherwise `openai-completions`. `poolModel` sets `supportsReasoningEffort`, `supportsStore`, `sessionAffinityFormat`.

Wraps live provider so `modelRegistry` catalog and `models.json` composition survive.
