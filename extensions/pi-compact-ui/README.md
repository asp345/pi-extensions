# pi-compact-ui (vendored)

Compact tree-shaped reasoning and tool-call UI for the Pi Coding Agent.

- Upstream: `npm:pi-compact-ui@0.1.1` by geoffreychen777 (https://pi.dev/packages/pi-compact-ui)
- Upstream ships no license file and no license field; treat this directory as third-party code vendored for personal use. Do not redistribute it separately.

## Behavior

Consecutive reasoning and tool calls collapse into one visual group (max 3 lines by default). `Ctrl+O` expands a group to show tool arguments, result previews, and reasoning text. `/compact-ui-config` opens the settings menu. Settings persist to `compact-ui.json` under the agent directory.

## Vendor adaptations

Kept minimal against upstream `index.ts`:

- Bare `fs`/`os`/`path` imports use the `node:` prefix (required by `scripts/check.ts`).
- The config path follows `getAgentDir()` (`<agent-dir>/compact-ui.json`) instead of hardcoded `~/.pi/agent/compact-ui.json`, matching every other extension in this repo. Upstream documents `~/.pi/agent/compact-ui.json`; an existing file there is not migrated automatically.
- Tool/container internals are typed against `pi-coding-agent` 0.85.1 (`Component`, `Theme`, `AssistantMessage`, tool views) with the pi-private access points isolated in small `*Internals` helpers. No `any` remains; the repo lint preset applies with no exceptions.
- The four copies of the group header (icon/label/color) and the two tool status renderers share `groupHead`/`statusIcon`/`statusColor` helpers.

## Interactions

- Re-registers the built-in tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `ls`) with empty renderers and delegates execution to the original implementations, so tool-guard extensions (`pi-nix-store-guard`, `pi-sensitive-guard`, `pi-tool-loop-guard`) keep working.
- Patches `Container.prototype` (`addChild`/`removeChild`/`clear`) process-wide. This also groups tool components rendered by `pi-subagents` overlays.
- Sets the hidden thinking label to `""` on every `session_start`.
- In `--mode rpc` children it loads inertly (no TUI): no stdout protocol output, one extra `/compact-ui-config` command.
