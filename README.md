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
- `extensions/pi-setup-custom-providers/`
- `extensions/pi-sensitive-guard/`
- `extensions/pi-web-access/`
- `extensions/question/`

The only included theme is `themes/flatland.json`.

`pi-setup-custom-providers` handles custom providers and their model metadata. It replaces the previously vendored setup wizard; the current implementation is local, and `openrouter-metadata.ts` remains a local addition.

Use `/custom-model` to add, edit, remove, and discover providers such as OpenRouter, Novita, Modal, and other OpenAI-compatible services. Provider definitions are stored in Pi's `models.json`, and credentials stay in Pi's auth storage when configured through `/login`. The extension never writes `settings.json`, so the `/models` allow-list is unaffected.

Every configured provider registers a `refreshModels` callback, so Pi refreshes model metadata on session start, when `/model` opens, and on `pi update --models`. Each refresh queries the provider's own listing endpoint and falls back to the public OpenRouter catalog for context windows, output limits, reasoning support, image input, and pricing. Offline refreshes reuse the persisted catalog instead of issuing requests, repeats within five minutes reuse the previous result, and a failed discovery keeps the configured list. Names, reasoning flags, and thinking maps set by hand are never overwritten, and models marked `manual` keep their limits.

Each reasoning model can carry a default thinking level and a map from Pi's levels to the values the provider expects, which is how `xhigh` and `max` become selectable for providers that support them.

For Pi's built-in OpenRouter provider, `openrouter-metadata.ts` keeps the bundled catalog as an offline and compatibility baseline, then refreshes validated metadata for matching models from OpenRouter's public catalog. It persists validated overlays in `~/.config/pi/openrouter-metadata-store.json`, revalidates them after five minutes, and retains the previous catalog on failure.

Subagents come from `extensions/pi-herdr-subagents/`, vendored from `pi-herdr-subagents@0.1.5` (MIT) and trimmed to the pi-only paths: bundled agents, the Claude CLI backend, the `/plan` workflow, and the config.json model layer were removed. Each subagent runs as a separate pi process in its own herdr pane. Agent definitions live in `~/.config/pi/agents/`.

herdr's pi integration (agent state reporting) stays herdr-managed at `~/.config/pi/extensions/herdr-agent-state.ts` via `herdr integration install pi`.


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
