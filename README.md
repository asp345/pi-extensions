# pi-config

My personal Pi monorepo.

## Extensions

Each extension lives in `extensions/<name>/` and is documented in its own `README.md`. The loaded extensions, prompts, and themes are listed under `pi` in `package.json`.

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
