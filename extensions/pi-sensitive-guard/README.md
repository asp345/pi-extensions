# pi-sensitive-guard

Sensitive-data guard for Pi. Scans reads, writes, shell, and git commands; redacts output.

## Config

`config.ts` loads `.pi/sensitive-guard.json`, `protectedPaths` with home/env expansion, `allowedPaths`, `readRedaction`, `contentScanning.blockSeverity high`, `gitProtection`.

## Detection

`scanner.ts` patterns: private keys, AWS `AKIA|ASIA`, `sk-proj`, `sk-ant`, `AIza`, `gh[oprsu]_`, `glpat-`, `xox[A-Za-z]-`, Stripe, SendGrid. `index.ts` blocks `cat|grep|cp|tee|git show|cat-file|checkout|restore|clean` targeting protected paths via `inspectShell`, including inline interpreters `python -c open()`, `node -e writeFileSync()` and `join`/`concat` obfuscation.

## UI

`ui.ts` registers redaction hook, `scanSecrets` redacts matched secrets in output up to `maxBytes 262144`.
