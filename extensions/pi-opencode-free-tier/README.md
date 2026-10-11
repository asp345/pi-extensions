# pi-opencode-free-tier

Satisfies the OpenCode Zen free-tier client checks for `opencode` provider models such as `opencode/big-pickle` or `opencode/muse-spark-1.3-contributor-free`.

Without this extension, `https://opencode.ai/zen/v1` answers free-tier models with `403 {"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}`.

## Verified request contract

Measured against the live endpoint with a valid Zen key. Each row was held constant while the others varied.

| Requirement | Accepted | Rejected |
|---|---|---|
| `User-Agent` | leading token `opencode/<version>` | `pi (…)`, bare `opencode`, `opencode/1.0.0` (426) |
| `x-opencode-session` | `ses_` + 12 lowercase hex + 14 base62 | pi session UUID, missing header |
| body `stream` | `true` | `false` or missing |
| body `tools` | declares `bash` and `read` | neither, one of them, or any other pair |

`x-opencode-request`, `x-opencode-session-id`, `x-opencode-project`, `x-opencode-client` are not part of the check. A valid API key in `Authorization` is required.

Both `openai-completions` (`/zen/v1/chat/completions`) and `openai-responses` (`/zen/v1/responses`) enforce the same contract.

## Behavior

The extension applies only to models on the Zen free lane: provider `opencode`, or a `opencode.ai` base URL outside `/zen/go`. `opencode-go` is left untouched.

- `before_provider_headers` sets `User-Agent: opencode/2.0.26` and replaces `x-opencode-session` with a canonical `ses_` id derived from the pi session id with SHA-256, so the id is stable for the whole conversation and preserves upstream cache routing.
- `before_provider_request` adds stub `bash` and `read` tool declarations when the outgoing payload contains neither. When the payload declares no tools at all, it sets `tool_choice: "none"` for `openai-completions` so the model cannot call the stubs. `openai-responses` rejects any `tool_choice` other than `"auto"`, so it is left unchanged there and a stub call surfaces as an unknown-tool error.

Normal agent turns already declare `bash` and `read`, so only tool-less auxiliary calls (for example session titles) reach the injection path.

## Verify

```bash
pi -p --model opencode/big-pickle "Reply with exactly: OK"
pi -p --model opencode/muse-spark-1.3-contributor-free "Reply with exactly: OK"
```

Source references: `packages/opencode/src/session/llm/request.ts` and `packages/opencode/src/id/id.ts` (v1), `packages/core/src/session/model-request.ts` (v2), `packages/console/app/src/routes/zen/util/handler.ts` (error wrapping).
