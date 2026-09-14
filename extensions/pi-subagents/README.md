# pi-subagents

Runs subagents as isolated `pi --mode rpc` child processes. Agent Markdown declares models in priority order:

```yaml
models:
  - parent
  - anthropic/claude-fable-5
  - openrouter/minimax/minimax-m3
thinking: parent
```

`parent` inherits the parent session's current model or thinking level. Missing or unavailable models are skipped. If a model fails, the agent continues the existing session with the next available model without repeating completed tool actions. Later resumes retain the selected model.

Each delegation requires a concrete task and an explicit context handoff. The extension adds the selected agent's role and working directory to that handoff; it does not copy the parent conversation unless `fork` is explicitly requested. `fork` appends the parent conversation tail as read-only reference text; unlike in-process sessions, raw tool calls are not replayed in the child.

## How it works

Each subagent is a separate OS process started with `pi --mode rpc` (`rpc.ts`). The parent communicates over the RPC JSONL protocol: `prompt`, `steer`, `follow_up`, `abort`, `get_messages`, `get_state`, `set_model`, `set_thinking_level`, plus the streamed session events (`message_update`, `tool_execution_start/end`, `turn_end`, `agent_settled`).

- Current session content: the child never sees the parent session automatically. The parent reads its own session (`ctx.sessionManager`) and embeds only what the handoff contains. Either side can re-read its own transcript at any time via `get_messages`.
- Interaction between sessions: the parent drives each child with `prompt`/`steer`/`follow_up`/`abort` and observes progress through events. A child reports progress with the `report_to_parent` tool (`report-tool.ts`, loaded via `-e`); the parent extracts the summary from the tool-call event and forwards it as steering. Children never talk to each other directly; the parent relays.
- Resume: a live child process keeps its session in memory and is reused. After a parent restart, the persisted `sessionFile` is reopened with `pi --mode rpc --session <file>`. Records without a session file start a fresh run.
- The child inherits auth and config from files and environment. `PI_SESSION_FILE` and `PI_SESSION_ID` are stripped so the child never attaches to the parent session.

## Limits

- `extensions`/`skills` allowlists beyond `true`/`false` have no CLI equivalent and are not enforced in the child; the `--tools` allowlist still restricts which tools the child can call.
- The child resolves `parent` models against the parent's registry at spawn time. Credentials refreshed only in parent memory are invisible to the child until they reach disk or the environment.
- One OS process per running subagent. Stopped processes are terminated on parent shutdown.

## Agents

Bundled definitions live in `extensions/pi-subagents/agents/`; global overrides live in `~/.config/pi/agents/`.

`/agents` opens the workspace, and while agents run a widget below the editor lists them: `shift+↑↓`, or `↓` then enter on an empty editor, opens the selected one. The workspace is a centered, bordered overlay that leaves the parent session visible around its edges. Its conversation is fetched from the tail, PgUp/PgDn scroll it, and the embedded editor steers the running agent or resumes a finished one.
