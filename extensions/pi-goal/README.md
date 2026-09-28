# pi-goal

Goal tracking for Pi with automatic continuation.

## Commands

`/goal <objective>` creates goal, `/goal status|pause|resume|clear` manages. Tools `goal_complete` and `goal_blocked` enforce lifecycle: `goal_complete` requires matching `goal_id` and verified summary, `goal_blocked` requires `repeated_turns >=3` with `reason`/`evidence`.

## Runtime

`GoalRuntime` persists to `goals.json`, caps owned prompt markers, and starts continuation only after the agent settles with no other queued messages. Running work, meaning any background task (from `pi-background-tasks:state`) or any running subagent (from `pi-subagents:state`), defers normal start/continue prompts (including the no-progress nudge). When the last running task or subagent finishes, continuation is re-driven. While any work runs, a check-in prompt is sent every 15 minutes once the agent is idle. Clearing a goal drops pending goal work and aborts only a currently running goal-owned turn. `resumeGoal` restores active goals across sessions without a default turn limit.
