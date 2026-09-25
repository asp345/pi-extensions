# pi-background-tasks

Background shell tasks for Pi without blocking the turn. Completion is delivered as steering at the next turn boundary.

## Tools

* `background_task` with `action: start|list|read|stop|clear`, optional `command`, `id`, `heartbeat` (minutes, default 30), `timeout` (total runtime in seconds)
* `bash` hybrid - commands remain in the foreground for up to 1 minute, `alt+h` hands off the most recent foreground command immediately, and `timeout` covers total foreground and background runtime; `guard.ts` blocks `sleep >=10s` or unknown durations.

Tool calls have no renderers of their own; `pi-compact-ui` renders them.

## Runtime

`BackgroundRuntime` spawns via `node:child_process`, assigns task IDs as `bg-` plus 6 random hex characters (regenerated on a collision within the runtime), tails output to 8000 chars, decodes UTF-8 split across chunks, publishes `BACKGROUND_TASKS_STATE_EVENT`, supports quiet tasks (`notify:false`) with `waitForExit` and late promotion, records explicit stops as `user`, `agent`, or `shutdown`, uses `discard` only for internal quiet-task cleanup, and provides `shutdown`/`activate` lifecycle.

## UI

- Below the editor, while any task is running: `bg tasks  ● 1 running  ✓ 2 done  ✗ 1 failed  · ctrl+shift+b`. Failed includes timed-out tasks. Counts of zero are omitted, here and in the dashboard.
- `/bg` or `ctrl+shift+b` opens the dashboard: counts, then `Running` (`◈`) and `Finished` (`✓` done, `✗` failed, `•` stopped) sections with `Task`, `Command`, `Status`, `Last output`, and `Time` columns (10 rows around the selection), then the selected task's pid, cwd, the last 10 output lines, and the log file. It re-renders every second while any task is running. Keys: `↑`/`↓` or `j`/`k` select, `shift+↑`/`shift+↓` scroll the output, `f` toggles following the output end, `s` stops the selected task, `c` clears finished tasks, `q` or `esc` closes. `/bg watch <id>` opens it with that task selected.
- `/bg list`, `/bg run <command>`, `/bg stop <id>`, and `/bg clear` work without the dashboard.
- Exits are delivered as a follow-up message and render as `◆ Background task finished · <id> · <command> · <time>` (`failed`, `stopped`, or `running` for heartbeat notices, which are not displayed); `ctrl+o` expands the output. Messages batched from several exits render one line per task.
