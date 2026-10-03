# pi-flat-edit

Replaces the built-in `edit` tool schema `{path, edits: [{oldText, newText}]}` with a single replacement `{path, oldText, newText}` for every model.

## Tool

* `edit` with `path`, `oldText`, `newText`. Multiple locations are changed with multiple `edit` calls in one response; calls on the same file are applied one at a time through the built-in file mutation queue.

`execute` passes `{path, edits: [{oldText, newText}]}` to the built-in `createEditToolDefinition(cwd).execute`, so matching, the fuzzy fallback, BOM and line ending preservation, errors, and `details.diff` are the built-in behavior. `constrainedSampling` is copied from the built-in definition. The built-in `prepareArguments` and renderers are not used; `pi-compact-ui` renders the call.

The tool is registered at load with `process.cwd()` and again on `session_start` with `ctx.cwd`.
