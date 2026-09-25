# pi-subagents

Runs subagents as in-process `AgentSession`s inside the parent Pi process. There is no agent catalog: every delegation states its role, objective, and context in the `launch_subagent` call. Subagents cannot launch subagents (depth 1).

## Tools

Parent session:

- `launch_subagent(name, prompt, context, model?, thinking?)` creates a subagent and returns its handle (`name`, ID, model) at admission. It never returns the answer. `model` (`provider/id`) and `thinking` default to the parent's model and thinking level.
- `send_message(to, message)` sends a message to a subagent by name or ID. A running subagent receives it as steering; an idle subagent starts a new turn; an inactive subagent is reopened from its session file and starts a new turn in the same context.
- `list_subagents()` lists name, ID, status, model, cost, and the last error.
- `stop_subagent(to)` aborts a running subagent and closes its session, which also stops its background tasks. The session file is kept; `send_message` resumes it.

Subagent session:

- `send_message(message)` delivers a message to the parent. It arrives as `[message from child:<name>]` and starts a parent turn (steering while the parent is running).

IDs are UUIDs; tools accept the name, the full ID, or an unambiguous ID prefix.

## Delivery

Results reach the parent only through the subagent's `send_message`. The subagent is told so in three places: the guideline of its `send_message` tool, the delegation prompt (`[task from parent]`), and every parent message (`[message from parent]`).

A subagent is running from `agent_start` until its session has settled and none of its background tasks is running. When that episode ends, the parent receives one follow-up notice if applicable:

- `[child-failed child:<name>]` with the error, when the prompt was rejected or the last assistant message ended with an error or an abort.
- `[child-exited: no-reply child:<name>]` with the last assistant text (up to 500 characters), when the subagent sent no message during the episode.
- `[child-exited: cancelled child:<name>]`, when the user stopped it from `/agents`. A stop through `stop_subagent` sends no notice.

## Status

- `running`: an episode is active.
- `idle`: the session is open and waiting for a message.
- `inactive`: no open session (stopped, or restored after a parent restart).

## Sessions and persistence

- The subagent session is created with `createAgentSessionServices` and `createAgentSessionFromServices` for the parent's cwd and project trust. It loads the same extensions, skills, and context files as the parent, so compaction (including `pi-compaction`) runs in the subagent as in the parent. Prompt templates and themes are not loaded.
- The extension that registers `launch_subagent` is removed from the subagent's extension set and replaced by an inline extension that provides the subagent `send_message`. `question`, `goal_complete`, and `goal_blocked` are excluded.
- Session files are written to `<parent session file without .jsonl>.subagents/`, with the parent session recorded as `parentSession`. They are not listed by `/resume`.
- Each record (name, prompt, cwd, model, thinking level, session file, cost, last text, last error) is appended to the parent session as a `pi-subagent-state` custom entry. On `session_start` the latest entry per ID on the branch is restored as `inactive`.
- On parent shutdown, reload, or session switch, open subagent sessions are aborted and closed (`session_shutdown` is emitted to their extensions) and their records are persisted.

Extensions share module-level state between the parent and its subagents because Pi caches extension modules per path. State that belongs to one session must live inside the extension factory or be keyed by session ID.

## UI

- Below the editor, while any subagent is running or idle: `subagents  ● 1 running  ◐ 1 idle  ○ 2 inactive  · ctrl+shift+s`. Counts of zero are omitted, here and in the dashboard.
- `/agents` or `ctrl+shift+s` opens the dashboard: counts, then `Running` (`◈`), `Idle` (`•`), and `Inactive` (`•`, dim) sections with `Session`, `Model` (`id:thinking`), `Activity`, `Cost`, and `Age` columns, and the last text or error of the selected subagent. It re-renders every second while any subagent is running. Keys: `↑`/`↓` or `j`/`k` move, `s` stops the selected subagent, `q` or `esc` closes.
- `/agents list` prints all subagents; `/agents stop <name|id>` stops one.
- Messages from subagents render as `◆ Agent message received · child:<name>` and notices as `◆ Subagent finished without reply · child:<name>`, `◆ Subagent failed · …`, or `◆ Subagent stopped · …`; `ctrl+o` expands the body.

## Limits

- Subagents run in the parent process. A parent exit stops them; they are resumed only by `send_message`.
- A provider error ends the episode with that error. There is no model fallback and no turn limit.
