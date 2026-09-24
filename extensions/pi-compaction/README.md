# pi-compaction

This extension selects either OpenAI Codex native encrypted compaction or Pi prompt-based text compaction.

## Configuration

The global configuration file is `pi-compaction.json` in Pi's agent configuration directory. `PI_CODING_AGENT_DIR` determines that directory when set. A trusted project can override individual settings with `.pi/pi-compaction.json`. Configuration is read when the extension instance starts; use `/reload` to apply edits.

```json
{
  "nativeCodex": true,
  "nativeClaude": true
}
```

`nativeCodex` defaults to `true`. It controls native compaction when the active model uses provider `openai-codex` and API `openai-codex-responses`.

`nativeClaude` defaults to `true`. It controls native compaction when the active model uses provider `anthropic` and API `anthropic-messages`.

Prompt-based compaction always uses the active session model.

`nativeCodex` and `nativeClaude` apply only to compaction of the active session model. Set them to `false` to always use prompt-based compaction.

## Codex native behavior

When native compaction is selected, the extension:

1. Converts the active Pi branch to Codex Responses items.
2. Sends the history and a trailing `compaction_trigger` to the Codex endpoint.
3. Stores the returned opaque `compaction` item in `CompactionEntry.details`.
4. Replaces subsequent Codex request history with retained recent user messages, the opaque checkpoint, and messages after the checkpoint.

The local compaction summary is a unique checkpoint marker required by Pi. The `context` and provider request handlers exclude this marker from requests to OpenAI.

Remote compaction is fail-closed. A failed request cancels compaction and retains the existing history. A malformed checkpoint blocks the next Codex request; a checkpoint written by a different extension version is ignored and the request continues on text history.

An existing native checkpoint remains native while an `openai-codex` model is active, including after switching Codex models or setting `nativeCodex` to `false`, because its `encrypted_content` cannot be converted to text locally. If a non-Codex model is active, the extension performs prompt-based compaction without replaying the checkpoint. The resulting text compaction supersedes the native checkpoint for subsequent requests; the old encrypted entry remains only in the full JSONL history.

## Claude native behavior

When native compaction is selected for an Anthropic model, the extension uses on-demand compaction (beta `compact-2026-09-04`, top-level `compaction` parameter). The summary instructions mirror Pi prompt-based compaction: the fixed section template (`Goal`, `Constraints & Preferences`, `Progress`, `Key Decisions`, `Next Steps`, `Critical Context`), the update variant when a previous summary exists, the `Build & Run Commands`/`Mistakes` focus, the `/compact` custom instructions, the read/modified file lists, and the split-turn `Turn Context` merge format:

1. Converts the summarized branch range to Anthropic Messages items. Orphaned `tool_use` blocks without `tool_result` get synthetic `No result provided` error results, mirroring the normal provider request path. Unsupported shapes still fall back to text compaction with a warning.
2. Sends the history with `compaction: {"type": "summarize"}` in a separate non-streaming request reusing the exact wire system prompt and tools from the last request. OAuth requests map tool names to Claude Code casing, append the deferred placeholder, replace the CLI identity block with the SDK identity block, and set `cache_control` breakpoints so the summary can hit prompt cache reads.
3. Stores the returned signed `compaction` block in `CompactionEntry.details`.
4. Rewrites subsequent Anthropic request payloads by replacing the summary text message with the signed block. Tail assistant `thinking` blocks are converted to plain text because their signatures were computed over the pre-compaction prefix and the server would drop them with `prefix_binding_mismatch`.

Requests carrying the block need beta `compact-2026-09-04`; the Anthropic provider fingerprint includes it on every request.

Unlike text compaction, the server-written swap keeps the recent turns valid without replaying their thinking blocks, provided the system prompt and tools are unchanged since the swap. The extension records both at compaction time and retires the checkpoint when either drifts, falling back to text history and excluding the block from the next summarize request. A model change or a disabled `nativeClaude` flag also retires the checkpoint.

Native compaction applies only to models reporting `capabilities.compaction` on the Models API, with a static family fallback. A failed summary request falls back to Pi prompt-based text compaction instead of cancelling compaction.

## Automatic compaction

The extension does not stop or resume agent runs. Pi controls the compaction threshold through its standard `compaction.reserveTokens` setting and handles provider-neutral continuation after automatic compaction. The `session_before_compact` hook replaces Pi's text summary with a native checkpoint when native Codex compaction is selected.

## Prompt-based behavior

Prompt-based compaction uses Pi's text summarizer. Its additional instructions preserve:

- exact successful setup, install, build, test, run, and lint commands;
- working directories, required environment variables, prerequisites, and success criteria;
- a record of mistakes relevant to subsequent work.

For `openai-completions` models, the extension instead reuses the last recorded wire request body for the session and appends the summary instructions (same section template, file lists, and split-turn format as above). The scope is bounded by a quoted boundary message. This keeps the shared prefix byte-identical so prompt-cache reads hit.

## Data handling

Native compaction sends the current Codex conversation to the ChatGPT Codex Responses endpoint. OpenAI returns `encrypted_content`, which is persisted in the local session JSONL and replayed to OpenAI Codex models.

Prompt-based compaction sends the text selected by Pi's compaction preparation to the active session model. Its plaintext summary is persisted in the session JSONL.

## Source

The native Codex implementation is derived from `@ogulcancelik/pi-codex-compaction` 0.1.3 by Can Celik. It is distributed under the MIT license in `LICENSE`.
