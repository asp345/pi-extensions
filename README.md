# pi-config

My personal Pi monorepo.


## Extensions

- `extensions/pi-anthropic-oauth/`
- `extensions/pi-antigravity-auth/`
- `extensions/pi-background-tasks/`
- `extensions/pi-compact-ui/`
- `extensions/pi-compaction/`
- `extensions/pi-custom-providers/`
- `extensions/pi-direnv/`
- `extensions/pi-footer/`
- `extensions/pi-goal/`
- `extensions/pi-gpt-search/`
- `extensions/pi-model-thinking/`
- `extensions/pi-nix-store-guard/`
- `extensions/pi-openai-models/`
- `extensions/pi-openrouter-metadata/`
- `extensions/pi-question/`
- `extensions/pi-sensitive-guard/`
- `extensions/pi-subagents/`
- `extensions/pi-system-prompt/`
- `extensions/pi-themes/`
- `extensions/pi-tool-loop-guard/`

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
