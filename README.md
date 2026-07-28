# pi-config

My personal Pi monorepo.

## Contents

### Extensions

- `extensions/github-copilot-auto/`
- `extensions/openrouter-metadata/`
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

`openrouter-metadata` keeps Pi's bundled OpenRouter catalog as an offline and compatibility baseline, then refreshes validated metadata for matching models from OpenRouter's public catalog. It persists validated overlays in `~/.pi/agent/openrouter-metadata-store.json`, revalidates them after five minutes, and retains the previous catalog on failure.

Subagents come from the `pi-herdr-subagents` npm dependency, loaded directly from `node_modules` via `pi.extensions`; each subagent runs as a separate pi process in its own herdr pane. Agent definitions live in `~/.pi/agent/agents/`.

`extensions/herdr-agent-state/` vendors herdr's pi integration (agent state reporting). herdr no longer manages the live copy: after a herdr integration update, re-run `herdr integration install pi`, copy the new file over `extensions/herdr-agent-state/index.ts`, and delete `~/.pi/agent/extensions/herdr-agent-state.ts` again.

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
