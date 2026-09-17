# pi-compact-ui (vendored)

One line per built-in tool call for the Pi Coding Agent. No grouping.

- Upstream: `npm:pi-compact-ui@0.1.1` by geoffreychen777 (https://pi.dev/packages/pi-compact-ui)
- Upstream ships no license file and no license field; treat this directory as third-party code vendored for personal use. Do not redistribute it separately.

## Behavior

Each tool call renders separately as exactly one plain line (`✓ bash bun run typecheck`, pending calls show `◌`) with no background block (`renderShell: "self"`). The line is truncated to the viewport width with `…`; a summary `suffix` (for example the bash elapsed time) always stays visible. Collapsed results render nothing, except `edit` and `write`. `edit` delegates to the native result renderer (full diff) and `write` delegates to the native call renderer (content preview, first 10 lines collapsed); both drop the native leading header line and blank line, so the output starts right under the one-line call; the write preview is indented by 3 columns, the diff is not. Errors and expanded results (`Ctrl+O`) delegate to the native result renderer. Thinking and everything else render natively.

## Vendor adaptations

Diverged from upstream `index.ts` (grouping and thinking interception removed):

- Bare `fs`/`os`/`path` imports use the `node:` prefix (required by `scripts/check.ts`).
- Tool internals are typed against `pi-coding-agent` 0.85.1 with no `any`; the repo lint preset applies with no exceptions.

## Interactions

- Re-registers the built-in tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `ls`) with a one-line call renderer and execution delegated to the native per-cwd definitions, so tool-guard extensions (`pi-nix-store-guard`, `pi-sensitive-guard`, `pi-tool-loop-guard`) keep working. Note: `pi-background-tasks` registers its hybrid `bash` earlier in extension order, so its entry wins for `bash`; the one-line style for `bash` lives on that hybrid definition (shared `compactCallLine` helper).
- Patches once, on load: `Container.prototype.addChild` records each component's parent, and `ToolExecutionComponent.prototype.render`/`handleMouse` drop the blank line that a `renderShell: "self"` row prepends when its previous visible sibling is another tool row (mouse rows are shifted by the removed line). A tool row that follows assistant text or thinking keeps its blank line.
- Keeps no transcript state. Native renderers keep their `lastComponent` reuse: the wrapper passes the wrapped component back and returns the same wrapper instance when the native renderer reuses it.
- In `--mode rpc` children it loads inertly (no TUI): no stdout protocol output.
