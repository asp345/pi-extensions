# pi-goal

Goal tracking for Pi with automatic continuation.

## Commands

`/goal <objective>` creates goal, `/goal status|pause|resume|clear` manages. Tools `goal_complete` and `goal_blocked` enforce lifecycle: `goal_complete` requires matching `goal_id` and verified summary, `goal_blocked` requires `repeated_turns >=3` with `reason`/`evidence`.

## Runtime

Goal state is stored as a `goal-state` session entry and restored on `session_start`. When the agent settles with no queued messages, the next prompt is sent as a `pi-goal` custom message. Running background tasks or subagents defer it, with a check-in every 15 minutes. `/goal clear` aborts only a goal-owned run.
