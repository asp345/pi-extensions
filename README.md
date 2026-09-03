# pi-config

My personal Pi monorepo.


## Extensions

- `extensions/pi-github-copilot/`
- `extensions/pi-anthropic-oauth/`
- `extensions/pi-antigravity-auth/`
- `extensions/pi-background-tasks/`
- `extensions/pi-compaction/`
- `extensions/pi-direnv/`
- `extensions/pi-goal/`
- `extensions/pi-gpt-search/`
- `extensions/pi-lsp/`
- `extensions/pi-nix-store-guard/`
- `extensions/pi-openrouter-metadata/`
- `extensions/pi-custom-providers/`
- `extensions/pi-sensitive-guard/`
- `extensions/pi-subagents/`
- `extensions/pi-service-tier/`
- `extensions/pi-stats/`
- `extensions/pi-model-thinking/`
- `extensions/pi-question/`
- `extensions/pi-themes/`

Each extension's details are documented in its own `README.md`.

## Development

```bash
nix develop
bun install --frozen-lockfile --ignore-scripts
bun run check
nix fmt
```

Install the package from the GitHub repository after dependencies are available:

```bash
pi install git:github.com/asp345/pi-config
```

Run an offline extension startup check with:

```bash
pi --no-extensions -e . --offline --list-models >/dev/null
```
