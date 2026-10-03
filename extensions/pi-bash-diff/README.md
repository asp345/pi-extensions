# pi-bash-diff

Records the files a `bash` tool call changed inside the current git repository and attaches their diffs to the tool result as `details.fileChanges`. `pi-compact-ui` renders them in the `bash` row in the same format as `edit` diffs.

## Behavior

The extension does not register or wrap `bash`. It observes `tool_call` and `tool_result` events for calls named `bash`, so it works with whichever extension provides the `bash` tool.

- Only `bash` calls issued by the model in a TUI session (`ctx.mode === "tui"`) are captured. Nested calls (`parentToolCallId` set) are skipped.
- `tool_call`: if `ctx.cwd` is inside a git work tree, records `HEAD` and the paths listed by `git status --porcelain=v1 -z --untracked-files=all --no-renames`, and reads the current content of each listed file.
- `tool_result`: runs `git status` again. Each path from either status run is compared:
  - paths listed before the command: against the content read before the command,
  - other paths: against the blob in the recorded `HEAD`, or an absent file when `HEAD` has none.
- Each changed path becomes `{ path, diff }`, with an absolute `path` and a `diff` from `generateDiffString` (the format of the `edit` tool's `details.diff`). Paths are sorted. The entries are merged into the existing `details`, so fields such as `backgroundTaskId` are kept.
- `details` is not sent to the model; the model-facing `content` is unchanged.
- Git runs with `--no-optional-locks` and `--literal-pathspecs`. Nothing is written to `.git`.
- If the snapshot fails, the command still runs and a warning notification shows the error.

`details.ts` exports `FileChange` and `fileChangesOf(details)`, which `pi-compact-ui` uses to read the entries.

## Limits

- Files outside the repository of `ctx.cwd`, ignored files, and directories (submodules) are not captured.
- Files with a NUL byte, files over 1 MiB, symlinks, and changes with an empty diff (creating or deleting an empty file) are omitted.
- When 10 or more files have a diff, no `fileChanges` are attached to the call.
- Changes made by other processes during the call, such as background tasks, parallel tool calls, or an editor, appear in the call's result.
- For a call handed off to a background task, the diff covers changes up to the hand-off.
- Every file listed by `git status` is read before each call, so the cost grows with the number of modified and untracked files.
