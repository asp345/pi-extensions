# cch attestation

Every `POST /v1/messages` request pi sends through this extension carries a `x-anthropic-billing-header` system block whose `cch` field is a real attestation hash, computed the same way Claude Code computes it.

## Wire format (Claude Code 2.1.288)

`system[0]` is always:

```
x-anthropic-billing-header: cc_version=<version>.<suffix>; cc_entrypoint=sdk-cli; cch=<hash>; cc_prompt_id=<uuid>; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;
```

Captured first-turn example (`claude -p "reply with the single word ok"`):

```
x-anthropic-billing-header: cc_version=2.1.288.7d4; cc_entrypoint=sdk-cli; cch=0dd0f; cc_prompt_id=f92b15d9-8fb0-4278-be5d-315c411b0250; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;
```

- `<suffix>` = `SHA-256("59cf53e54c78" + msg[4] + msg[7] + msg[20] + version)[:3]`, where `msg` is the current user prompt text (`"0"` padded past the end).
- `<hash>` = `xxHash64(normalized_body, lanes) & 0xFFFFF`, formatted as 5 lowercase hex chars, zero-padded.
- `cc_prompt_index` / `cc_turn_index` are new in 2.1.288 (both `0` / `1` on a first turn; the binary string table also contains `cc_prev_req=`, `cc_is_subagent=true` and `cc_workload=` for other shapes). pi sends the first-turn shape on every request because it mints a fresh `prompt_id` per turn with no turn counter.

## Hash input normalization

The hash is computed over the exact serialized request bytes, with the `cch` digits first reset to `00000`, then transformed:

- every `"model"` string value is emptied (quotes kept),
- members named `"max_tokens"`, `"fallbacks"`, `"fallback_credit_token"` are removed with comma cleanup (a trailing run of two or more keeps its preceding comma, matching Claude Code 2.1.220 behavior).

These rules are unchanged from 2.1.278 through 2.1.288.

## Hash lanes (changed in 2.1.288)

Up to 2.1.280 the hash was standard xxHash64 with a seed (`0x4D659218E32A3268`): `v1 = seed+P1+P2`, `v2 = seed+P2`, `v3 = seed`, `v4 = seed-P1`. In 2.1.288 the native fetch hook loads four fixed lane constants instead of deriving them from a seed:

```
v1 = 0xae4fba0790eae83e
v2 = 0x101840560aff1db7
v3 = 0x4d659218e32a3268
v4 = 0xaf2e18675d3e67e1
```

Everything else (stripe rounds, tail handling, avalanche) is unchanged standard xxHash64. Bodies under 32 bytes take the short path with `hash = v3 + P5`, which is numerically identical to the old `seed + P5` because the old seed equals the new `v3`. `index.ts` keeps these as `CCH_V1`..`CCH_V4`.

`index.ts` builds the header with the `cch=00000` placeholder in `onPayload` and patches the real value in a `fetch` wrapper, so the hash always covers the exact bytes on the wire.

## Request fingerprint reference (2.1.288)

Captured alongside the billing header from the same `claude -p` runs:

- `User-Agent: claude-cli/2.1.288 (external, sdk-cli)`
- `x-app: cli`
- `anthropic-beta:` the 16-entry list in `CLAUDE_CODE_BETA`, with `inline-tools-2026-09-15` in place of the captured `mid-conversation-tool-changes-2026-07-01` because pi-ai sends mid-conversation tools as inline `tool_definition` blocks (`mid-conversation-output-config-2026-07-01`, `fine-grained-tool-streaming-2025-05-14`, `server-side-fallback-2026-07-01` and `compact-2026-09-04` are gone compared to 2.1.280)
- `x-cc-atis: aa3b964b4dcc5049` is stable across sessions and prompts (install/account attestation, not a body hash), so pi does not emulate it.

## How this was found

1. Captured Claude Code 2.1.278 traffic with mitmproxy (`HTTP_PROXY`/`HTTPS_PROXY` plus `~/.mitmproxy/mitmproxy-ca-cert.pem` as `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`). Two `claude -p` runs gave `cch=d52e2` and `cch=ad311` for otherwise near-identical 54570-byte bodies, proving the value is a per-request body hash.
2. Extracted the attribution constructor from the CLI binary strings (function `XEn`): JS assembles the header with a `cch=00000` placeholder on first-party OAuth paths, and a native fetch hook replaces it before sending. No seed exists in JS or as a plain binary constant, so the hash itself lives in native code.
3. Ruled out `SHA-256`/`MD5`/`xxHash64` with seeds `0`, `1`, `0x6E52736AC806831E` (2.1.37, from public reverse-engineering) over raw, message-only, system-only, and header-removed inputs.
4. CLIProxyAPI's `internal/runtime/executor/claude_signing.go` documents the missing piece: the hash covers a *normalized* view (rules above), with seed `0x4D659218E32A3268`. A from-scratch Python reimplementation reproduced captured values exactly, confirming seed and rules for 2.1.278 and re-confirmed on a 2.1.280 capture.
5. The version suffix salt `59cf53e54c78` was confirmed the same way: it reproduces the captured `02b` suffix for the prompt `"reply with the single word ok"`.
6. For 2.1.288, re-captured three `claude -p` runs through mitmproxy and saved the raw request bytes. The old seed derivation no longer reproduced any captured `cch`. Disassembling the 2.1.288 binary (`cstool x64`) showed the fetch hook loading the four lane constants above via `movabs` into a streaming-xxHash64 state struct, and the digest function doing converge + tail + avalanche with no stripe loop (stripes are consumed while feeding). Re-running the Python reimplementation with fixed lanes reproduced both captured bodies exactly (`cch=0dd0f` on the 60527-byte body, `cch=4251e` on the 60554-byte body with a different prompt), and the unchanged suffix formula reproduced both captured suffixes (`7d4`, `e42`).

## Maintenance

- The lanes rotate between Claude Code releases. When bumping `CLAUDE_CODE_VERSION` (exported from `pi-anthropic-oauth/index.ts`, also used by `pi-footer/providers/anthropic.ts`), re-capture one CLI request and re-run the check in step 6; a mismatch means new lanes (`movabs` constants in the fetch hook) or changed normalization.
- The beta list also changes between releases: diff the captured `anthropic-beta` header against `CLAUDE_CODE_BETA` and drop/add entries to match.
- The suffix salt has been stable across all observed versions.
- The server currently accepts any 5-hex `cch` on regular OAuth requests (random values returned 200 during testing), so wrong lanes degrade to unattested rather than failing. Gated features may enforce it strictly.
