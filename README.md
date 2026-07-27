# pi-config

My personal Pi monorepo.

## Contents

### Extensions

- `extensions/github-copilot-auto/`
- `extensions/pi-anthropic-oauth/`
- `extensions/pi-antigravity-auth/`
- `extensions/pi-background-tasks/`
- `extensions/pi-direnv/`
- `extensions/pi-goal/`
- `extensions/pi-lsp/`
- `extensions/pi-sensitive-guard/`
- `extensions/pi-subagents/`
- `extensions/pi-web-access/`
- `extensions/question/`

The only included theme is `themes/flatland.json`.

Agent Markdown declares models in priority order:

```yaml
models:
  - parent
  - anthropic/claude-fable-5
  - openrouter/minimax/minimax-m3
thinking: parent
```

`parent` inherits the parent session's current model or thinking level. Missing or unavailable models are skipped. If a model fails, the agent continues the existing session with the next available model without repeating completed tool actions. Later resumes retain the selected model unless the `Agent` call explicitly selects another model.

## Development

```bash
nix develop
npm ci --ignore-scripts
npm run check
nix fmt
```

The development shell provides Node.js 24, Biome, `typescript-language-server`, and `nixd`. It also configures the Pi LSP extension to use the shell's Biome and nixd binaries.

Install the package locally after dependencies are available:

```bash
pi install /absolute/path/to/pi-config
```

Run an offline extension startup check with:

```bash
pi --no-extensions -e . --offline --list-models >/dev/null
```
