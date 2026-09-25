# pi-compact-ui

Renders every tool call in the Pi Coding Agent transcript in one uniform format. Tool definitions do not need their own renderers: the format is applied to all tools, including built-in tools and tools from other packages, and `renderCall`/`renderResult`/`renderShell` of tool definitions are ignored.

## Format

Collapsed, each call is one line:

```
 ✓ read · extensions/pi-compact-ui/row.ts · ↓ 214 lines · 38ms
 ◈ bash · bun run check · 12.4s
 ✗ edit · README.md · 21ms · error
```

- Marker: `◇` queued, `◇ ◈ ◆ ◈` animated every 250 ms while running, `✓` done, `✗` error.
- Tool name, then the preview: the first non-blank string found by a depth-first walk over the arguments in key order (`read` → `path`, `bash` → `command`, `web` → the first `q`).
- `↓ N lines`: the line count of the text result, shown once the call has finished.
- Duration: measured from `markExecutionStarted` to the final result. Calls replayed from a saved session have no duration.
- The preview is truncated with `…`; the counts, duration, and error label stay visible.

A result whose `details.diff` is a string (the `edit` tool) adds a summary line in both states:

```
    ╰─ extensions/pi-compact-ui/row.ts +12 -3
```

Expanded (`ctrl+o`, or a click on the header line):

- `╰─ key: value` for each top-level argument; non-string values are JSON.
- ` › ` followed by the text result, or the syntax-highlighted diff with line-number gutters when `details.diff` is present.
- `waiting for output...` while running, `no output` for an empty result.

Images in results render below the row. A tool row directly after another tool row, or after an assistant message without visible text, has no leading blank line.

## Implementation

- Patches `ToolExecutionComponent.prototype` once per process: `render` and `handleMouse` are replaced when a TUI session starts (`ctx.mode === "tui"`), `markExecutionStarted` and `updateResult` record the timing, and `Container.prototype.addChild` records each component's parent for the spacing rule.
- Sessions without a TUI (print, RPC, and in-process subagent sessions) do not install the renderer.
- `row.ts` builds the lines, `diff.ts` renders the diff block.
