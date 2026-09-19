# pi-compact-ui (vendored)

One line per built-in tool call for the Pi Coding Agent. No grouping.

- Upstream: `npm:pi-compact-ui@0.1.1` by geoffreychen777 (https://pi.dev/packages/pi-compact-ui)
- Upstream ships no license file and no license field; treat this directory as third-party code vendored for personal use. Do not redistribute it separately.

## Behavior

Each tool call renders separately as exactly one plain line (`✓ read ~/cfg/pi/package.json`, pending calls show `◌`) with no background block (`renderShell: "self"`). The line is truncated to the viewport width with `…`; a summary `suffix` (for example the bash elapsed time) always stays visible. Collapsed results render nothing, except `edit` and `write`, which share one code-block renderer: every line has a `<sign><line number> ` gutter whose sign uses `toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext` and whose line number uses `thinkingText`, the code is syntax highlighted for the language of the path (tabs become three spaces), and added or removed lines carry a full-width `toolSuccessBg`/`toolErrorBg` background. `edit` takes the lines from `details.diff`, `write` from the `content` argument numbered from 1. Both show 30 lines with a `... (N more lines, M total, <key> to expand)` hint and expand to the full block with `Ctrl+O`. Errors, `edit` without a diff, and `write` without content delegate to the native result renderer. Thinking and everything else render natively.

## Vendor adaptations

Diverged from upstream `index.ts` (grouping and thinking interception removed):

- Bare `fs`/`os`/`path` imports use the `node:` prefix (required by `scripts/check.ts`).
- Tool internals are typed against `pi-coding-agent` 0.85.1 with no `any`; the repo lint preset applies with no exceptions.

## Interactions

- Re-registers the built-in tools (`read`, `edit`, `write`, `find`, `grep`, `ls`) with a one-line call renderer and execution delegated to the native per-cwd definitions, so tool-guard extensions (`pi-nix-store-guard`, `pi-sensitive-guard`, `pi-tool-loop-guard`) keep working. `bash` is owned by `pi-background-tasks`, whose hybrid definition renders its call line through the exported `compactCallLine`/`toolSummary` helpers.
- Patches once, on load: `Container.prototype.addChild` records each component's parent, and `ToolExecutionComponent.prototype.render`/`handleMouse` drop the blank line that a `renderShell: "self"` row prepends when its previous visible sibling is another tool row (mouse rows are shifted by the removed line). A tool row that follows assistant text or thinking keeps its blank line.
- Keeps no transcript state. The code-block renderer reuses `context.lastComponent` when it is already a code block; delegated native renderers receive `lastComponent` unchanged.
- In `--mode rpc` children it loads inertly (no TUI): no stdout protocol output.
