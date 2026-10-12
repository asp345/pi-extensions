# pi-compaction

Codex models use OpenAI Codex native encrypted compaction. Other models use full-context text compaction.

## Configuration

`pi-compaction.json` in Pi's agent configuration directory, or `.pi/pi-compaction.json` in a trusted project:

```json
{
  "nativeCodex": true
}
```

`nativeCodex` (default `true`) selects native compaction for provider `openai-codex` with API `openai-codex-responses`.

## Text compaction

The summary request sends the full session context followed by the summary instructions, and summarizes only the messages before the first kept message. `max_tokens` is `min(floor(0.8 * reserveTokens), model.maxTokens)`. For API `anthropic-messages`, the message cache breakpoint is placed where the previous request cached, so the request reads the cached prefix and writes no cache entry.

## Source

The native Codex implementation is based on `@ogulcancelik/pi-codex-compaction` 0.1.3.
