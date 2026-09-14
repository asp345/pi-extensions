# pi-extensions

My personal Pi monorepo. This `debian` branch targets Debian GNU/Linux with bash and bun; `main` targets NixOS.


## Extensions

- `extensions/pi-anthropic-oauth/`
- `extensions/pi-antigravity-auth/`
- `extensions/pi-background-tasks/`
- `extensions/pi-compaction/`
- `extensions/pi-direnv/`
- `extensions/pi-goal/`
- `extensions/pi-gpt-search/`
- `extensions/pi-nix-store-guard/`
- `extensions/pi-openrouter-metadata/`
- `extensions/pi-compact-ui/`
- `extensions/pi-custom-providers/`
- `extensions/pi-sensitive-guard/`
- `extensions/pi-subagents/`
- `extensions/pi-openai-models/`
- `extensions/pi-footer/`
- `extensions/pi-model-thinking/`
- `extensions/pi-question/`
- `extensions/pi-system-prompt/`
- `extensions/pi-themes/`
- `extensions/pi-tool-loop-guard/`

Each extension's details are documented in its own `README.md`.

## Development

This branch does not use the Nix flake. Install bun (>=1.4) and run:

```bash
npm install -g bun        # or: curl -fsSL https://bun.sh/install | bash
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Install the package from the GitHub repository after dependencies are available:

```bash
pi install git:github.com/asp345/pi-extensions@debian
```

Or install the local checkout directly:

```bash
pi install /path/to/pi-extensions
```

Run an offline extension startup check with:

```bash
pi --no-extensions -e . --offline --list-models >/dev/null
```
