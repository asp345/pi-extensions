# pi-opencode-free-tier

Satisfies the OpenCode Zen free-tier client checks for `opencode` provider models such as `opencode/big-pickle` or `opencode/cat-jam-free`.

Without this extension, `https://opencode.ai/inference/v1` answers free-tier models with `403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}`.

## Verified request contract

Measured against the live endpoint with a valid Zen key.

| Requirement | Accepted | Rejected |
|---|---|---|
| `User-Agent` | `opencode/2.0.26`, `opencode/latest/2.0.29/cli` | `pi (…)`, bare `opencode`, `opencode/1.0.0` (426) |
| session header | one of `x-opencode-session-id`, `x-opencode-session`, `x-session-affinity`, `x-session-id` carrying `ses_` + 12 lowercase hex + 14 base62 | all four missing, pi session UUID, malformed id |
| body `stream` | `true` | `false` or missing |
| body `tools` | declares `read`, and every declared `bash`, `edit`, `glob`, `grep`, `read`, `shell`, `write` has a non-empty `parameters.properties` | no `read`, empty schema on one of those names |

The same request returns `200` from the official client or a Bun `fetch` and `403` from curl, so the check covers the client transport as well. A valid API key in `Authorization` is required.

## Behavior

The extension applies only to models on the Zen free lane: provider `opencode`, or a `opencode.ai` base URL outside `/zen/go`.

- `before_provider_headers` sets `User-Agent: opencode/2.0.26` and all four session headers to the same id, built by the client's `Identifier.create(true)` algorithm: `~(timestamp * 0x1000 + counter)` as its low 48 bits in hex, then 14 base62 characters mapped with `byte % 62`. The timestamp is the pi session's creation time, the counter is `1 + digest[5] % 63` over the SHA-256 of the pi session id, and the base62 tail is the remaining digest bytes, so the id stays fixed for a pi session.
- `before_provider_request` sets `stream: true`, adds a `read` stub when the payload declares no `read` tool, and fills a placeholder property into a declared `bash`/`edit`/`glob`/`grep`/`read`/`shell`/`write` tool whose `parameters.properties` is empty. A payload that already satisfies the contract is left unchanged.

## Verify

```bash
pi -p --model opencode/big-pickle "Reply with exactly: OK"
pi -p --model opencode/cat-jam-free "Reply with exactly: OK"
pi -p -nt --model opencode/cat-jam-free "Reply with exactly: OK"
```

Source references: `packages/schema/src/identifier.ts`, `packages/core/src/session/model-request.ts`, `packages/console/app/src/lib/inference-proxy.ts`. The check itself runs in the deployed `opencode-inference-<stage>` worker, which is not in the public repository.
