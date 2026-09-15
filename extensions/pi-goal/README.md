# pi-goal

Goal tracking for Pi with automatic continuation.

## Commands

`/goal <objective>` creates goal, `/goal status|pause|resume|clear` manages. Tools `goal_complete` and `goal_blocked` enforce lifecycle: `goal_complete` requires matching `goal_id` and verified summary, `goal_blocked` requires `repeated_turns >=3` with `reason`/`evidence`.

## Runtime

`GoalRuntime` persists to `goals.json`, caps owned prompt markers, and starts continuation only after the agent settles with no other queued messages. Any running background task defers normal start/continue prompts (including the no-progress nudge) until tasks complete, which re-drives continuation. While any background task runs, a check-in prompt is sent every 15 minutes once the agent is idle. Clearing a goal drops pending goal work and aborts only a currently running goal-owned turn. `resumeGoal` restores active goals across sessions without a default turn limit.
