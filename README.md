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
- `extensions/pi-web-access/`
- `extensions/question/`

The only included theme is `themes/flatland.json`.

Subagents come from the external `pi-herdr-subagents` package (installed via `pi install npm:pi-herdr-subagents`), which runs each subagent as a separate pi process in its own herdr pane. Agent definitions live in `~/.pi/agent/agents/`.

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
