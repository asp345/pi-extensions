# pi-goal

Goal tracking for Pi with automatic continuation.

## Commands

`/goal <objective>` creates goal, `/goal status|pause|resume|clear` manages. Tools `goal_complete` and `goal_blocked` enforce lifecycle: `goal_complete` requires matching `goal_id` and verified summary, `goal_blocked` requires `repeated_turns >=3` with `reason`/`evidence`.

## Runtime

`GoalRuntime` persists to `goals.json`, caps owned prompt markers, owns continuation prompt exactly once, re-drives continuation on goal-owned background task completion, ignores unowned tasks. `resumeGoal` restores active goal across sessions without default turn limit.
