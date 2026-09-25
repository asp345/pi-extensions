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
2. Sends the history and a trailing `compaction_trigger` through the registered provider (see [Request path](#request-path)) over SSE. The request keeps the provider-built `instructions`, `tools`, `prompt_cache_key`, and reasoning settings, and sets `store: false`, `include: ["reasoning.encrypted_content", ...]`, and the `remote_compaction_v2` feature header.
3. Stores the returned opaque `compaction` item in `CompactionEntry.details`.
4. Replaces subsequent Codex request history with retained recent user messages, the opaque checkpoint, and messages after the checkpoint.

The local compaction summary is a unique checkpoint marker required by Pi. The `context` and provider request handlers exclude this marker from requests to OpenAI.

Remote compaction is fail-closed. A failed request cancels compaction and retains the existing history. A malformed checkpoint blocks the next Codex request; a checkpoint written by a different extension version is ignored and the request continues on text history.

An existing native checkpoint remains native while an `openai-codex` model is active, including after switching Codex models or setting `nativeCodex` to `false`, because its `encrypted_content` cannot be converted to text locally. If a non-Codex model is active, the extension performs prompt-based compaction without replaying the checkpoint. The resulting text compaction supersedes the native checkpoint for subsequent requests; the old encrypted entry remains only in the full JSONL history.

## Claude native behavior

When native compaction is selected for an Anthropic model, the extension uses on-demand compaction (beta `compact-2026-09-04`, top-level `compaction` parameter). The summary instructions mirror Pi prompt-based compaction: the fixed section template (`Goal`, `Constraints & Preferences`, `Progress`, `Key Decisions`, `Next Steps`, `Critical Context`), the update variant when a previous summary exists, the `Build & Run Commands`/`Mistakes` focus, the `/compact` custom instructions, the read/modified file lists, and the split-turn `Turn Context` merge format:

1. Builds the request context from the session projection before `firstKeptEntryId`: the transcript system message, the previous summary, and the summarized messages.
2. Sends it through the registered Anthropic provider (see [Request path](#request-path)) with the top-level `compaction: {"type": "summarize", "instructions": ...}` parameter and the `compact-2026-09-04` beta. The provider builds the system blocks, tools, messages, thinking settings, and `cache_control` with the same conversion as for session requests, the OAuth provider in `pi-anthropic-oauth` adds its fingerprint and `cch`, and the checkpoint rewrite below is applied. The signed block is read from the `content_block_start` event and the usage from the `message_delta` event of the SSE response; any `stop_reason` other than `compaction` fails the summary.
3. Stores the returned signed `compaction` block in `CompactionEntry.details`.
4. Rewrites subsequent Anthropic request payloads by replacing the summary text message with the signed block. Tail assistant `thinking` blocks are converted to plain text because their signatures were computed over the pre-compaction prefix and the server would drop them with `prefix_binding_mismatch`.

Requests carrying the block need beta `compact-2026-09-04`; the Anthropic provider fingerprint includes it on every request.

Unlike text compaction, the server-written swap keeps the recent turns valid without replaying their thinking blocks, provided the system prompt and tools are unchanged since the swap. The extension records both at compaction time and retires the checkpoint when either drifts, falling back to text history and excluding the block from the next summarize request. A model change or a disabled `nativeClaude` flag also retires the checkpoint.

Native compaction applies only to models reporting `capabilities.compaction` on the Models API, with a static family fallback. A failed summary request (including a `refusal` stop reason) falls back to Pi prompt-based text compaction instead of cancelling compaction.

## Automatic compaction

The extension does not stop or resume agent runs. Pi controls the compaction threshold through its standard `compaction.reserveTokens` setting and handles provider-neutral continuation after automatic compaction. The `session_before_compact` hook replaces Pi's text summary with a native checkpoint when native Codex or Claude compaction is selected.

## Prompt-based behavior

Prompt-based compaction uses Pi's text summarizer. Its additional instructions preserve:

- exact successful setup, install, build, test, run, and lint commands;
- working directories, required environment variables, prerequisites, and success criteria;
- a record of mistakes relevant to subsequent work.

For `openai-completions` models, when the first kept entry contains text of at least 20 characters, the extension instead sends the full session context plus a user message with the summary instructions (same section template, file lists, and split-turn format as above) through `ctx.modelRegistry.streamSimple` with the session ID. The scope is bounded by a quoted boundary message. The provider converts the context with the same conversion as for session requests. Otherwise Pi's text summarizer is used.

## Request path

Native compaction requests go through `ctx.modelRegistry.streamSimple`, the same registered provider stream (including extension providers such as `pi-anthropic-oauth`) that session requests use, with the session ID and the session thinking level:

- `onPayload` adds the compaction fields to the provider-built payload.
- A `fetch` override sends the final request itself, because the provider does not parse compaction responses. It retries up to 3 attempts on HTTP 408, 409, 429, and 5xx and on network errors, honoring `retry-after`, with a 300-second timeout. The provider receives a non-retryable HTTP 400 in place of the response.

No wire request is recorded between requests; the request is rebuilt from the session transcript, which carries the system prompt and tool declarations (see `pi-system-prompt`).

## Data handling

Native compaction sends the current Codex conversation to the ChatGPT Codex Responses endpoint. OpenAI returns `encrypted_content`, which is persisted in the local session JSONL and replayed to OpenAI Codex models.

Prompt-based compaction sends the text selected by Pi's compaction preparation to the active session model. Its plaintext summary is persisted in the session JSONL.

## Source

The native Codex implementation is derived from `@ogulcancelik/pi-codex-compaction` 0.1.3 by Can Celik. It is distributed under the MIT license in `LICENSE`.
