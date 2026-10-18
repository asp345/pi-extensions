# pi-background-tasks

Background shell tasks for Pi without blocking the turn. Completion is recorded in the session and delivered to the model at the next turn boundary, or starts a turn when Pi is idle.

## Tools

* `background_task` with `action: start|list|read|stop|clear`, optional `command`, `id`, `heartbeat` (minutes, default 30), `timeout` (total runtime in seconds)
* `bash` hybrid - commands remain in the foreground for up to 1 minute, `alt+h` hands off the most recent foreground command immediately, and `timeout` covers total foreground and background runtime. A handed-off call returns a non-error result with the output so far, the hand-off note, and `details.backgroundTaskId`; `guard.ts` blocks `sleep` totals of 30s or more and unknown durations.

Tool calls have no renderers of their own; `pi-compact-ui` renders them.

## Runtime

`BackgroundRuntime` spawns via `node:child_process`, assigns task IDs as `bg-` plus 6 random hex characters (regenerated on a collision within the runtime), tails output to 8000 chars, decodes UTF-8 split across chunks, publishes `BACKGROUND_TASKS_STATE_EVENT`, supports quiet tasks (`notify:false`) with `waitForExit` and late promotion, records stops as `user`, `agent`, or the `session_shutdown` reason (`quit`, `reload`, `new`, `resume`, `fork`), uses `discard` only for internal quiet-task cleanup, and provides `shutdown(reason)`/`activate` lifecycle. `shutdown(reason)` kills running tasks and emits their exit events before clearing the task map.

## Delivery

Exit and heartbeat events become `pi-background-tasks:event` custom messages.

An exit message contains `Background task <id> finished (<status>) after <duration>.`, then the last 3000 characters of output starting at the first complete line, then `[Full output: <logFile>]` when the output is longer. The log file is deleted by `clear` and at `session_shutdown`.

- Idle: sent with `triggerTurn: true`, which starts a run.
- During a run: held by the extension, then appended as `custom_message` entries at the next `turn_end` or `agent_before_settle` boundary with `continue: true`.
- Still held at `agent_settled`: appended, and a new run starts unless the run was aborted.
- `session_shutdown`: held events and the exits of killed tasks are appended with `triggerTurn: false`.

While a task with notifications runs, `cache_warming_decision` returns `{ "action": "warm" }` unless `pi-anthropic-oauth` uses a 1-hour OAuth cache.

Messages are lost when Pi quits during a run (Pi defers custom messages until the run ends) or the process is killed. A task finishing during a manual `/compact` is delivered with the next run without starting one.

## UI

- Below the editor, while any task is running: `bg tasks  ● 1 running  ✓ 2 done  ✗ 1 failed  · ctrl+shift+b`. Failed includes timed-out tasks. Counts of zero are omitted, here and in the dashboard.
- `/bg` or `ctrl+shift+b` opens the dashboard: counts, then `Running` (`◈`) and `Finished` (`✓` done, `✗` failed, `•` stopped) sections with `Task`, `Command`, `Status`, `Last output`, and `Time` columns (10 rows around the selection), then the selected task's pid, cwd, the last 10 output lines, and the log file. It re-renders every second while any task is running. Keys: `↑`/`↓` or `j`/`k` select, `shift+↑`/`shift+↓` scroll the output, `f` toggles following the output end, `s` stops the selected task, `c` clears finished tasks, `q` or `esc` closes. `/bg watch <id>` opens it with that task selected.
- `/bg list`, `/bg run <command>`, `/bg stop <id>`, and `/bg clear` work without the dashboard.
- Exits render as `◆ Background task finished · <id> · <command> · <time>` (`failed`, `stopped`, or `running` for heartbeat notices, which are not displayed); `ctrl+o` expands the output.
