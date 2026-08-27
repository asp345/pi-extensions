# pi-background-tasks

Background shell tasks for Pi without blocking the turn. Completion is delivered as steering at the next turn boundary.

## Tools

* `background_task` with `action: start|list|read|stop|clear`, optional `command`, `id`, `heartbeat` (minutes, default 30), `timeout` (seconds)
* `bash` hybrid - `registerHybridBash` starts a background task and ends the turn; `guard.ts` blocks `sleep >=10s` or unknown durations

## Runtime

`BackgroundRuntime` spawns via `node:child_process`, tails output to 8000 chars, decodes UTF-8 split across chunks, publishes `BACKGROUND_TASKS_STATE_EVENT`, supports quiet tasks (`notify:false`) with `waitForExit` and late promotion, `discard` SIGTERM then SIGKILL, `shutdown`/`activate` lifecycle.

## UI

`ui.ts` renders `taskLine`, still-running heartbeat notification, immediate steering on exit.
