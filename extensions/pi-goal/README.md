# pi-goal

Goal tracking for Pi with automatic continuation.

## Commands

`/goal <objective>` creates goal, `/goal status|pause|resume|clear` manages. Tools `goal_complete` and `goal_blocked` enforce lifecycle: `goal_complete` requires matching `goal_id` and verified summary, `goal_blocked` requires `repeated_turns >=3` with `reason`/`evidence`.

## Runtime

`GoalRuntime` persists to `goals.json`, caps owned prompt markers, and starts continuation only after the agent settles with no other queued messages. Any running background task defers normal start/continue prompts (including the no-progress nudge) until tasks complete, which re-drives continuation. Goal-owned background tasks additionally trigger an hourly check-in after the agent settles. Clearing a goal drops pending goal work and aborts only a currently running goal-owned turn. `resumeGoal` restores active goals across sessions without a default turn limit.
