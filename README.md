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

Subagents come from `extensions/pi-herdr-subagents/`, vendored from `pi-herdr-subagents@0.1.5` (MIT) and trimmed to the pi-only paths: bundled agents, the Claude CLI backend, the `/plan` workflow, and the config.json model layer were removed. Each subagent runs as a separate pi process in its own herdr pane. Agent definitions live in `~/.pi/agent/agents/`.

herdr's pi integration (agent state reporting) stays herdr-managed at `~/.pi/agent/extensions/herdr-agent-state.ts` via `herdr integration install pi`.

`extensions/herdr-handoff/` moves sessions onto herdr automatically: when pi starts outside herdr while a herdr server is reachable, it closes any stale pane holding the same session, opens a pane in the workspace for the cwd, relaunches the session there, and shuts the outside instance down (`PI_HERDR_HANDOFF=0` disables).

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
