# pi-lsp

Language Server Protocol integration for Pi. Tools `lsp_diagnostics` and `lsp_fix` are active only when at least one configured LSP command resolves at session start. Availability remains fixed for that session.

## Routing

`routing.ts` loads trusted `.pi/lsp.json` or agent dir config, builds `ServerConfig { command, extensions, skipDirectories, initialization, diagnosticsGraceMs }`, selects routes via `diagnosticRoutes`/`fixRoute` by extension and path. Defaults: `biome`, `ty`, `ruff`, `rust-analyzer`, `gopls`, etc. Skips `node_modules,dist,target,__pycache__`.

## Protocol

`protocol.ts` spawns LSP server, validates `TextEdit` ranges, applies edits via `applyEdits` with strict positions, supports `source.fixAll` (default). Queues writes with file mutation queue. Untrusted projects cannot supply `command`.

`MAX_OUTPUT_BYTES 30000`, `MAX_OUTPUT_LINES 500`.
