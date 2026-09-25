# pi-background-tasks

Background shell tasks for Pi without blocking the turn. Completion is delivered as steering at the next turn boundary.

## Tools

* `background_task` with `action: start|list|read|stop|clear`, optional `command`, `id`, `heartbeat` (minutes, default 30), `timeout` (total runtime in seconds)
* `bash` hybrid - commands remain in the foreground for up to 1 minute, `alt+h` hands off the most recent foreground command immediately, and `timeout` covers total foreground and background runtime; `guard.ts` blocks `sleep >=10s` or unknown durations.

Tool calls have no renderers of their own; `pi-compact-ui` renders them.

## Runtime

`BackgroundRuntime` spawns via `node:child_process`, assigns task IDs as `bg-` plus 6 random hex characters (regenerated on a collision within the runtime), tails output to 8000 chars, decodes UTF-8 split across chunks, publishes `BACKGROUND_TASKS_STATE_EVENT`, supports quiet tasks (`notify:false`) with `waitForExit` and late promotion, records explicit stops as `user`, `agent`, or `shutdown`, uses `discard` only for internal quiet-task cleanup, and provides `shutdown`/`activate` lifecycle.

## UI

`ui.ts` renders `taskLine`, still-running heartbeat notification, immediate steering on exit.
