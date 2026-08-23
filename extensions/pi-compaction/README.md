# pi-compaction

This extension integrates OpenAI Codex remote compaction with Pi's compaction lifecycle. Other providers use Pi text compaction with extra instructions that preserve exact build and run commands.

## Codex behavior

The native implementation activates only when the model provider is `openai-codex` and its API is `openai-codex-responses`.

For manual, threshold, and overflow compaction, the extension:

1. Converts the active Pi branch to Codex Responses items.
2. Sends the history and a trailing `compaction_trigger` to the Codex endpoint.
3. Stores the returned opaque `compaction` item in `CompactionEntry.details`.
4. Replaces subsequent Codex request history with retained recent user messages, the opaque checkpoint, and messages after the checkpoint.

The local compaction summary is a unique checkpoint marker required by Pi. The `context` and provider request handlers exclude this marker from requests to OpenAI.

Remote compaction is fail-closed. A failed request cancels compaction and retains the existing history. A malformed checkpoint or a checkpoint created by another Codex model blocks the next Codex request.

## Turn-boundary threshold

The extension checks Pi's reported context usage after every `turn_end`. At the configured ratio it aborts the active run, invokes Pi compaction after the session settles, and sends a visible continuation message when no user message is pending.

Pi processes queued steering and follow-up messages before `agent_settled`. Compaction can therefore remain deferred while those queues are pending. Pi does not currently expose an extension API that inserts compaction between queued turns.

## Configuration

Mid-run compaction is enabled at 90% by default:

```json
{
  "autoCompact": true,
  "thresholdRatio": 0.9
}
```

The global configuration file is `pi-compaction.json` in Pi's agent configuration directory. `PI_CODING_AGENT_DIR` determines that directory when set. A trusted project can override it with `.pi/pi-compaction.json`.

`thresholdRatio` must satisfy $0 < r < 1$. Pi's `compaction.reserveTokens` setting independently controls Pi's own threshold.

## Other providers

For non-Codex models, the extension uses Pi's text summarizer. Its summary instructions preserve:

- exact successful setup, install, build, test, run, and lint commands;
- working directories, required environment variables, prerequisites, and success criteria;
- a record of mistakes relevant to subsequent work.

## Data handling

The current Codex conversation is sent to the ChatGPT Codex Responses endpoint. OpenAI returns `encrypted_content`, which is persisted in the local session JSONL and replayed only to the matching Codex model.

Native checkpoints are model-specific. Provider or model switching does not convert them to textual summaries.

## Source

The native Codex implementation is derived from `@ogulcancelik/pi-codex-compaction` 0.1.3 by Can Celik. It is distributed under the MIT license in `LICENSE`.
