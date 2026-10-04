# pi-extensions

My personal Pi monorepo. This `debian` branch targets Debian GNU/Linux with bash and bun; `main` targets NixOS.

## Extensions

Each extension lives in `extensions/<name>/` and is documented in its own `README.md`. The loaded extensions, prompts, and themes are listed under `pi` in `package.json`.

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
