# pi-nix-store-guard

Blocks `/nix/store` searches in Pi.

Intercepts `read,grep,find,ls,bash,background_task:start`. `guard.ts` matches `/nix/store` via `STORE_RE` and allows only Pi's package directory itself, its `docs` and `examples` subtrees, and its `README.md` via `allowedStorePath`. The paths come from the SDK's `getPackageDir`, `getDocsPath`, `getExamplesPath`, and `getReadmePath`, which honor `PI_PACKAGE_DIR`. Blocks with `Blocked: /nix/store search (<path>). Read <docs>, <examples>, or <README.md>, or use nix eval.`
