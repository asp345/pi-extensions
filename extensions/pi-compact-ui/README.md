# pi-compact-ui

Renders every tool call in the Pi Coding Agent transcript in one uniform format. Tool definitions do not need their own renderers: the format is applied to all tools, including built-in tools and tools from other packages, and `renderCall`/`renderResult`/`renderShell` of tool definitions are ignored.

## Format

Collapsed, each call is one line:

```
 ✓ read · extensions/pi-compact-ui/row.ts · ↓ 214 lines · 0s
 ◈ bash · bun run check · 12s
 ↗ bash · nix build · bg-1a2b3c · 1m 0s
 ✗ edit · README.md · 0s · error
```

- Marker: `◇` queued, `◈` running, `↗` handed off to a background task, `✓` done, `✗` error.
- A result whose `details.backgroundTaskId` is set (a `bash` call that `pi-background-tasks` moved to the background) shows the task ID before the duration; the duration stops at the hand-off.
- Tool name, then the preview: the first non-blank string found by a depth-first walk over the arguments in key order (`read` → `path`, `bash` → `command`, `web` → the first `q`).
- `↓ N lines`: the line count of the text result, shown once the call has finished, except for `edit` and `write` rows that show a diff preview.
- Duration: whole seconds (floored). A running row shows the time since `markExecutionStarted` and is re-rendered every second to advance it. A finished row shows the `durationMs` recorded on the final result, including calls replayed from a saved session. Results without `durationMs` (aborted calls and results stored before pi 1.1.0) have no duration.
- The preview is truncated with `…`; the counts, duration, and error label stay visible.

A result whose `details.diff` is a string (the `edit` tool) adds a summary line in both states:

```
    ╰─ extensions/pi-compact-ui/row.ts +12 -3
```

A successful `write` call adds a summary line with the written line count while collapsed:

```
    ╰─ notes.md +40
```

A result whose `details.fileChanges` lists files (a `bash` call that `pi-bash-diff` diffed) adds one summary line per file in both states:

```
    ╰─ src/a.py +2 -2
    ╰─ notes.md +3 -0
```

While collapsed, each summary line is followed by up to 20 rendered rows of the syntax-highlighted diff with line-number gutters (for `write`, the written `content` as added lines), then `… N more lines` when rows were cut. The limit applies to each file separately. The highlight language comes from the file name through `languageFromPath` in `@asp345/pi-shared/language.ts`.

Expanded (`ctrl+o`, or a click on the header line):

- `╰─ key: value` for each top-level argument; non-string values are JSON. A completed `write` omits `content`.
- When `details.diff` is present, or for a completed `write`, the summary line and the full syntax-highlighted diff with line-number gutters (for `write`, the written `content` as added lines).
- Otherwise ` › ` followed by the text result.
- When `details.fileChanges` is present, a blank line after the text result, then each file's summary line and full diff.
- `waiting for output...` while running, `no output` for an empty result.

Images in results render below the row. A tool row directly after another tool row, or after an assistant message without visible text, has no leading blank line.

## Implementation

- Patches `ToolExecutionComponent.prototype` once per process: `render` and `handleMouse` are replaced when a TUI session starts (`ctx.mode === "tui"`), `markExecutionStarted` and `updateResult` record the timing, `invalidate` clears the row's cached lines, and `Container.prototype.addChild` records each component's parent for the spacing rule.
- Sessions without a TUI (print, RPC, and in-process subagent sessions) do not install the renderer.
- Each row caches its lines and rebuilds them only when the width, arguments, result, expanded state, running state, or elapsed whole seconds change.
- `row.ts` builds the lines, `diff.ts` renders the diff block.
