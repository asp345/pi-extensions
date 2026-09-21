# cch attestation

Every `POST /v1/messages` request pi sends through this extension carries a
`x-anthropic-billing-header` system block whose `cch` field is a real
attestation hash, computed the same way Claude Code computes it.

## Wire format

`system[0]` is always:

```
x-anthropic-billing-header: cc_version=<version>.<suffix>; cc_entrypoint=sdk-cli; cch=<hash>; cc_prompt_id=<uuid>; cc_turn_origin=sdk;
```

- `<suffix>` = `SHA-256("59cf53e54c78" + msg[4] + msg[7] + msg[20] + version)[:3]`,
  where `msg` is the current user prompt text (`"0"` padded past the end).
- `<hash>` = `xxHash64(normalized_body, 0x4D659218E32A3268) & 0xFFFFF`,
  formatted as 5 lowercase hex chars, zero-padded.

## Hash input normalization

The hash is computed over the exact serialized request bytes, with the `cch`
digits first reset to `00000`, then transformed:

- every `"model"` string value is emptied (quotes kept),
- members named `"max_tokens"`, `"fallbacks"`, `"fallback_credit_token"` are
  removed with comma cleanup (a trailing run of two or more keeps its
  preceding comma, matching Claude Code 2.1.220 behavior).

`index.ts` builds the header with the `cch=00000` placeholder in `onPayload`
and patches the real value in a `fetch` wrapper, so the hash always covers
the exact bytes on the wire.

## How this was found

1. Captured Claude Code 2.1.278 traffic with mitmproxy
   (`HTTP_PROXY`/`HTTPS_PROXY` plus `~/.mitmproxy/mitmproxy-ca-cert.pem` as
   `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`). Two `claude -p` runs gave
   `cch=d52e2` and `cch=ad311` for otherwise near-identical 54570-byte
   bodies, proving the value is a per-request body hash.
2. Extracted the attribution constructor from the CLI binary strings
   (function `XEn`): JS assembles the header with a `cch=00000` placeholder
   on first-party OAuth paths, and a native fetch hook replaces it before
   sending. No seed exists in JS or as a plain binary constant, so the hash
   itself lives in native code.
3. Ruled out `SHA-256`/`MD5`/`xxHash64` with seeds `0`, `1`,
   `0x6E52736AC806831E` (2.1.37, from public reverse-engineering) over raw,
   message-only, system-only, and header-removed inputs.
4. CLIProxyAPI's `internal/runtime/executor/claude_signing.go` documents the
   missing piece: the hash covers a *normalized* view (rules above), with
   seed `0x4D659218E32A3268`. A from-scratch Python reimplementation
   reproduced both captured values exactly, confirming seed and rules for
   2.1.278.
5. The version suffix salt `59cf53e54c78` was confirmed the same way: it
   reproduces the captured `02b` suffix for the prompt
   `"reply with the single word ok"`.

## Maintenance

- The seed rotates between Claude Code releases. When bumping
  `CLAUDE_CODE_VERSION`, re-capture one CLI request and re-run the check in
  step 4; a mismatch means a new seed.
- The suffix salt has been stable across all observed versions.
- The server currently accepts any 5-hex `cch` on regular OAuth requests
  (random values returned 200 during testing), so a wrong seed degrades to
  unattested rather than failing. Gated features may enforce it strictly.
