# pi-subagents

Runs subagents as isolated `pi --mode rpc` child processes. There is no agent catalog: every delegation states its role, objective, and handoff in the `launch_subagent` call.

Each subagent inherits the parent model and thinking level unless the call overrides them with `model` or `thinking`. The parent conversation is never copied; the child sees only the delegation prompt and evidence it inspects itself.

## How it works

Each subagent is a separate OS process started with `pi --mode rpc` (`rpc.ts`). The parent communicates over the RPC JSONL protocol: `prompt`, `steer`, `follow_up`, `abort`, `get_messages`, `get_state`, `set_model`, `set_thinking_level`, plus the streamed session events (`message_update`, `tool_execution_start/end`, `turn_end`, `agent_settled`).

- Child configuration (`runner.ts:buildChildArgs`): parent system prompt plus a subagent bridge block and the working directory, `--exclude-tools` for the parent-only tools (`launch_subagent`, `get_subagent_result`, `steer_subagent`, `control_subagent`, `list_subagents`, `question`, `goal_complete`, `goal_blocked`) so children cannot delegate further, ask the user, or drive the parent goal, `--extension report-tool.ts`, `--no-prompt-templates --no-themes --no-context-files`, and `--approve`/`--no-approve` from the parent trust state.
- Current session content: the child never sees the parent session. The parent embeds only what the `prompt` and `context` arguments contain. Either side can re-read its own transcript via `get_messages`.
- Interaction between sessions: the parent drives each child with `prompt`/`steer`/`abort` and observes progress through events. A child reports progress with the `report_to_parent` tool (`report-tool.ts`); the parent extracts the summary from the tool-call event and forwards it as steering. Children never talk to each other; the parent relays.
- Resume: a live child process keeps its session in memory and is reused. After a parent restart, the persisted `sessionFile` is reopened with `pi --mode rpc --session <file>`. A record without a live process and without a session file restarts from its original delegation prompt.
- The child inherits auth and config from files and environment. `PI_SESSION_FILE` and `PI_SESSION_ID` are stripped so the child never attaches to the parent session.
- Sessions are always persisted, and the child transcript is written to `<sessionFile>.output.json` when the run finishes.

## Limits

- The child resolves the model against the parent's registry at spawn time. Credentials refreshed only in parent memory are invisible to the child until they reach disk or the environment.
- A provider error ends the run with that error. There is no model fallback chain and no turn limit.
- One OS process per running subagent. Running processes are terminated on parent shutdown.

## Tools

- `launch_subagent(title, prompt, context, run_in_background?, model?, thinking?)`. `run_in_background` defaults to true; background results arrive as steering at the next turn boundary.
- `get_subagent_result(id, transcript?, offset?, limit?)` for the final answer or a bounded paginated transcript.
- `steer_subagent(id, message)`, `control_subagent(id, stop|resume)`, `list_subagents()`.

While agents run, a status widget below the editor shows the running count (`Subagents N running · ctrl+shift+s dashboard`). Progress reports and background completions render in the main transcript as one line; expand them with `ctrl+o`.

## Dashboard and manual control

- `/agents` opens the dashboard, `/agents list` prints all agents with full IDs, `/agents stop <id>` stops a running agent, `/agents resume <id>` resumes an inactive one.
- `ctrl+shift+s` opens the dashboard (same as `/agents`). Inside: `↑/↓` move, `s` stops the selected agent, `r` resumes it, `a` toggles finished agents, `q` closes.
- IDs are UUIDs; tools accept the full ID (whitespace trimmed, case-insensitive) plus unambiguous prefixes. `No subagent matched` errors list available IDs, and `list_subagents` recovers IDs when the model loses one.
