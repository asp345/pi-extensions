# pi-nix-store-guard

Blocks `/nix/store` searches in Pi.

Intercepts `read,grep,find,ls,bash,background_task:start`. `guard.ts` matches `/nix/store` via `STORE_RE` and allows only `PI_PACKAGE_DIR/docs`, `examples`, `README.md` via `allowedStorePath`. Blocks with `Blocked: /nix/store search (<path>). Read $PI_PACKAGE_DIR/docs, examples, or README.md, or use nix eval.`
