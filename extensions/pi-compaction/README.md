# pi-compaction

This extension selects either OpenAI Codex native encrypted compaction or Pi prompt-based text compaction.

## Configuration

The global configuration file is `pi-compaction.json` in Pi's agent configuration directory. `PI_CODING_AGENT_DIR` determines that directory when set. A trusted project can override individual settings with `.pi/pi-compaction.json`.

```json
{
  "nativeCodex": true,
  "textModel": {
    "provider": "opencode-go",
    "id": "glm-5.2"
  }
}
```

`nativeCodex` defaults to `true`. It controls native compaction when the active model uses provider `openai-codex` and API `openai-codex-responses`.

`textModel` is optional. It fixes the model used for every prompt-based compaction. Without it, prompt-based compaction uses the active model. The configured provider and model must exist in Pi's model registry and have valid authentication. A resolution or authentication error cancels compaction instead of selecting another model.

Use GPT Luna for prompt-based compaction while retaining native compaction for active Codex sessions with:

```json
{
  "nativeCodex": true,
  "textModel": {
    "provider": "openai-codex",
    "id": "gpt-5.6-luna"
  }
}
```

A non-Codex active model then uses GPT Luna for its summary. Set `nativeCodex` to `false` in the same configuration when active Codex sessions must also use prompt-based compaction.

A model selected through `textModel` is always called with Pi's ordinary summarization prompt, including when its provider is `openai-codex`. This call uses the provider's `streamSimple` implementation and does not append `compaction_trigger`, so it does not request native encrypted compaction. `nativeCodex` applies only to compaction of the active session model.

## Codex native behavior

When native compaction is selected, the extension:

1. Converts the active Pi branch to Codex Responses items.
2. Sends the history and a trailing `compaction_trigger` to the Codex endpoint.
3. Stores the returned opaque `compaction` item in `CompactionEntry.details`.
4. Replaces subsequent Codex request history with retained recent user messages, the opaque checkpoint, and messages after the checkpoint.

The local compaction summary is a unique checkpoint marker required by Pi. The `context` and provider request handlers exclude this marker from requests to OpenAI.

Remote compaction is fail-closed. A failed request cancels compaction and retains the existing history. A malformed checkpoint or a checkpoint created by another Codex model blocks the next Codex request.

An existing native checkpoint remains native even after `nativeCodex` is set to `false`, because its `encrypted_content` cannot be converted to text locally. The extension continues replaying and compacting that checkpoint with its matching Codex model. Start a new session to change that session to prompt-based compaction.

## Turn-boundary threshold

When native compaction is enabled, the extension checks Pi's reported context usage after every `turn_end`. At 90% it aborts the active run, invokes Pi compaction after the session settles, and sends a visible continuation message when no user message is pending.

Pi processes queued steering and follow-up messages before `agent_settled`. Compaction can therefore remain deferred while those queues are pending. Pi does not currently expose an extension API that inserts compaction between queued turns.

Pi's `compaction.reserveTokens` setting independently controls Pi's own threshold.

## Prompt-based behavior

Prompt-based compaction uses Pi's text summarizer. Its additional instructions preserve:

- exact successful setup, install, build, test, run, and lint commands;
- working directories, required environment variables, prerequisites, and success criteria;
- a record of mistakes relevant to subsequent work.

## Data handling

Native compaction sends the current Codex conversation to the ChatGPT Codex Responses endpoint. OpenAI returns `encrypted_content`, which is persisted in the local session JSONL and replayed only to the matching Codex model.

Prompt-based compaction sends the text selected by Pi's compaction preparation to `textModel`, or to the active model when `textModel` is omitted. Its plaintext summary is persisted in the session JSONL.

## Source

The native Codex implementation is derived from `@ogulcancelik/pi-codex-compaction` 0.1.3 by Can Celik. It is distributed under the MIT license in `LICENSE`.
