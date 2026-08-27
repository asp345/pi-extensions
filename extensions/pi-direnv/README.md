# pi-direnv

direnv integration for Pi.

On `session_start` runs `direnv export json` in `ctx.cwd`. If exit 0, parses JSON as `Record<string, string | null>` and applies to `process.env` (null deletes). If exit non-zero and stderr contains `is blocked`, notifies `".envrc is blocked. Run direnv allow"`. Failures without blocking are silent. Missing `direnv` binary is ignored.
