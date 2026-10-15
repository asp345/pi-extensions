# pi-opencode-free-tier

Satisfies the OpenCode Zen free-tier client checks for `opencode` provider models such as `opencode/big-pickle` or `opencode/cat-jam-free`.

Without this extension, `https://opencode.ai/inference/v1` answers free-tier models with `403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}`.

## Verified request contract

Measured against the live endpoint with a valid Zen key.

| Requirement | Accepted | Rejected |
|---|---|---|
| `User-Agent` | `opencode/2.0.26`, `opencode/latest/2.0.29/cli` | `pi (…)`, bare `opencode`, `opencode/1.0.0` (426) |
| `x-opencode-session` | `ses_` + 12 lowercase hex + 14 base62, last three hex digits `fc0`..`fff` | pi session UUID, missing header, last three hex digits below `fc0`, uppercase hex digits, body length other than 26, non-base62 tail |
| body `stream` | `true` | `false` or missing |
| body `tools` | declares `bash` and `read` | neither, one of them, or any other pair |

The embedded timestamp is not checked: only the last three hex digits, which are the counter of the client's generator, matter. A valid API key in `Authorization` is required, and the other `x-opencode-*` headers are not part of the check. `/inference/v1/systemone` carries no check at all.

## Behavior

The extension applies only to models on the Zen free lane: provider `opencode`, or a `opencode.ai` base URL outside `/zen/go`.

- `before_provider_headers` sets `User-Agent: opencode/2.0.26` and replaces `x-opencode-session` with an id built by the client's `Identifier.create(true)` algorithm: `~(timestamp * 0x1000 + counter)` as its low 48 bits in hex, then 14 base62 characters mapped with `byte % 62`. The timestamp is the pi session's creation time, the counter is `1 + digest[5] % 63` over the SHA-256 of the pi session id, and the base62 tail is the remaining digest bytes, so the id stays fixed for a pi session.
- `before_provider_request` adds stub `bash` and `read` tool declarations when the outgoing payload contains neither. When the payload declares no tools at all, it sets `tool_choice: "none"` for `openai-completions` so the model cannot call the stubs. `openai-responses` rejects any other `tool_choice`, so it is left unchanged there.

## Verify

```bash
pi -p --model opencode/big-pickle "Reply with exactly: OK"
pi -p --model opencode/cat-jam-free "Reply with exactly: OK"
```

Source references: `packages/schema/src/identifier.ts`, `packages/core/src/session/model-request.ts`, `packages/console/app/src/lib/inference-proxy.ts`. The check itself runs in the deployed `opencode-inference-<stage>` worker, which is not in the public repository.
