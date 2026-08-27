# pi-subagents

Runs subagents inside the parent session. Agent Markdown declares models in priority order:

```yaml
models:
  - parent
  - anthropic/claude-fable-5
  - openrouter/minimax/minimax-m3
thinking: parent
```

`parent` inherits the parent session's current model or thinking level. Missing or unavailable models are skipped. If a model fails, the agent continues the existing session with the next available model without repeating completed tool actions. Later resumes retain the selected model.

Each delegation requires a concrete task and an explicit context handoff. The extension adds the selected agent's role and working directory to that handoff; it does not copy the parent conversation unless `fork` is explicitly requested.

## Agents

Bundled definitions live in `extensions/pi-subagents/agents/`; global overrides live in `~/.config/pi/agents/`.

`/agents` opens the workspace, and while agents run a widget below the editor lists them: `shift+↑↓`, or `↓` then enter on an empty editor, opens the selected one. The workspace is a centered, bordered overlay that leaves the parent session visible around its edges. Its conversation is fetched from the tail, PgUp/PgDn scroll it, and the embedded editor steers the running agent or resumes a finished one.