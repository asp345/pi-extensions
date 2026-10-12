# pi-goal

Goal tracking for Pi with automatic continuation.

## Commands

`/goal <objective>` creates goal, `/goal status|pause|resume|clear` manages. Tools `goal_complete` and `goal_blocked` enforce lifecycle: `goal_complete` requires matching `goal_id` and verified summary, `goal_blocked` requires `repeated_turns >=3` with `reason`/`evidence`.

## Runtime

`GoalRuntime` persists goal state as a `goal-state` custom session entry and starts continuation only after the agent settles with no other queued messages. Start, continue, nudge, and check-in prompts are sent as `pi-goal` custom messages with `triggerTurn`; `before_agent_start` treats a run started by a `pi-goal` custom message as goal-owned. Running work, meaning any background task (from `pi-background-tasks:state`) or any running subagent (from `pi-subagents:state`), defers normal start/continue prompts (including the no-progress nudge). When the last running task or subagent finishes, continuation is re-driven. While any work runs, a check-in prompt is sent every 15 minutes once the agent is idle. Clearing a goal drops pending goal work and aborts only a currently running goal-owned turn. On `session_start`, `loadGoal` restores the latest `goal-state` entry on the current branch, and an active goal continues without a default turn limit. `/goal resume` reactivates a paused or blocked goal with a new goal ID and reset turn counters.
