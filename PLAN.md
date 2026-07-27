# Extension Rewrite Plan

## Objective

Rewrite all extensions as small, readable TypeScript modules while preserving the selected tools, providers, safety behavior, and interactive interfaces. Reduce source size, dependencies, and LLM context without routing difficult work to weak models.

## Principles

- Keep one clear implementation for each behavior.
- Preserve stable tool names unless this plan explicitly replaces them.
- Infer workspace state and defaults instead of exposing unnecessary parameters.
- Put advanced agent configuration in Markdown and interactive UI.
- Keep security checks at trust boundaries.
- Bound tool output and store large results for later retrieval.
- Load agent prompts and skill bodies only when selected.
- Choose subagents by task capability, never merely by cost or speed.

## Default subagents

All default and custom agents are Markdown files. The default set is `Plan`, `Explore`, `General`, and `Oracle`.

| Agent | Purpose | Model class | Tools |
| --- | --- | --- | --- |
| `Explore` | Locate files, symbols, references, and small factual excerpts | Lightweight search model | `read`, `bash`, `grep`, `find`, `ls` |
| `Plan` | Understand architecture and produce implementation plans | Capable planning model | `read`, `bash`, `grep`, `find`, `ls` |
| `General` | Perform multi-step analysis, research, debugging, and implementation | Capable general model | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `lsp_diagnostics`, `lsp_fix`, `web_search`, `source_check`, `fetch_content`, `get_search_content` |
| `Oracle` | Perform difficult cross-file reasoning, correctness review, security analysis, and root-cause diagnosis | Strongest configured reasoning model | `read`, `bash`, `grep`, `find`, `ls`, `lsp_diagnostics`, `web_search`, `source_check`, `fetch_content`, `get_search_content` |

### Routing policy

`Explore` is only for bounded discovery. It must not receive:

- Cross-file correctness analysis
- Architecture or design decisions
- Root-cause debugging
- Security review
- Complex code review
- Tasks requiring synthesis across several subsystems

Use `General` for broad implementation or multi-step analysis. Use `Plan` for architecture and sequencing. Use `Oracle` when correctness depends on deep reasoning or ambiguous evidence.

The parent-facing `Agent` description must state this distinction directly. Routing must be based on task complexity, not on the availability of a cheaper Explore model. If `Explore` receives an unsuitable task, it should report the scope mismatch rather than attempt shallow analysis.

### Markdown format

Every agent must explicitly declare its tools. Missing `tools` is a configuration error.

```markdown
---
description: Fast read-only code locator
tools: read, bash, grep, find, ls
model: openai-codex/gpt-5.4-mini
thinking: low
max_turns: 12
prompt_mode: replace
---

Locate relevant files and symbols. Do not perform architectural or correctness analysis.
```

Discovery locations remain:

- `.pi/agents/*.md`
- `.agents/agents/*.md`
- `~/.pi/agent/agents/*.md`

Supported frontmatter remains: `description`, `display_name`, `tools`, `extensions`, `exclude_extensions`, `skills`, `model`, `thinking`, `max_turns`, `persist_session`, `output_transcript`, `session_dir`, `prompt_mode`, `fork`, `run_in_background`, `memory`, `worktree`, and `enabled`.

`isolated` is removed. Built-in and extension tool names use one `tools` list and resolve against Pi's complete tool registry.

### Context and lifecycle

- New subagents start with a fresh conversation.
- `fork: true` copies the parent's active conversation into the new subagent.
- `resume` continues an existing subagent and cannot be combined with `fork`.
- `max_turns` remains available as a per-call override.
- Worktree isolation remains separate from context forking.

The LLM-facing interface becomes:

```ts
Agent({
  prompt: string,
  subagent_type: string,
  run_in_background?: boolean,
  model?: string,
  max_turns?: number,
  resume?: string,
  fork?: boolean,
})
```

The UI title is derived from the agent type and prompt.

## Context budget

### Skills

Use Pi's progressive disclosure model.

- `skills: true` uses normal child-session discovery.
- `skills: false` disables skills.
- `skills: a,b` exposes only those skill names.
- Parent and child startup context contains skill name, a short description, and path only.
- Full `SKILL.md` content is read only when the selected agent needs it.
- Explicit skill lists must not inline complete skill bodies into the system prompt.

### Agent definitions

- The parent sees agent names and one-line descriptions only.
- A selected agent's Markdown body loads only after invocation.
- Other agents' bodies never enter that child's context.
- Compact tool descriptions are the only supported mode.

### Tool descriptions and results

- Limit each tool description to one or two sentences.
- Keep parameter descriptions short and omit repeated examples.
- Use at most two essential `promptGuidelines` per tool.
- Return concise summaries by default.
- Store large search results, transcripts, diagnostics, and logs behind IDs.
- Apply strict byte and line limits to every tool result.

## LLM-facing tools

### Subagents

```ts
get_subagent_result({
  id: string,
  transcript?: boolean,
  offset?: number,
  limit?: number,
})

steer_subagent({ id: string, message: string })
```

By default, result retrieval returns metadata and the final assistant answer. `transcript: true` returns bounded, paginated user and assistant text with compact tool-invocation markers. It never includes raw or verbose tool-result payloads. Successful tool results become one-line status markers; tool errors retain only a bounded error summary. The complete internal conversation remains available to the `/agents` viewer without entering the parent LLM context.

Keep foreground and background execution, resume, steering, cancellation, turn limits, model overrides, forking, custom Markdown agents, worktrees, completion notifications, and the complete `/agents` UI. Launch asynchronously by default; foreground execution must be an explicit choice for an immediate dependency. A selectable agent fleet is rendered below the main editor. At an empty prompt, Down activates it; Up/Down changes only the pending selection, Enter opens that agent in the native-style workspace, and other input returns to the editor. `/agents` remains the explicit command. Reuse Pi's exported native message, tool, and editor components; submitted workspace input steers or resumes the selected agent. Keep the fleet widget and agent creation/editing screens. Defer completion follow-ups while the parent is running, discard results consumed before delivery, and batch remaining notifications when the parent settles.

Remove scheduling, cross-extension RPC, group joining, model scoping, and eager skill loading.

### Web

```ts
web_search({
  queries: string[],
  provider?: "auto" | "openai" | "gemini",
  limit?: number,
  recency?: "day" | "week" | "month" | "year",
  domains?: string[],
})

source_check({ claim: string, fetch?: boolean })

fetch_content({
  urls: string[],
  question?: string,
  timestamp?: string,
  frames?: number,
})

get_search_content({
  id: string,
  item?: number,
  offset?: number,
  limit?: number,
})
```

Keep OpenAI Search and Gemini API Search, automatic provider selection, citations, multi-query search, HTML extraction, PDF extraction, GitHub repositories, YouTube transcripts, video frames, bounded result storage, and SSRF protection.

Remove other search providers, Gemini browser-cookie access, curator workflows, browser UI, web-search commands, shortcuts, widgets, and historical-result management.

### Background tasks

Expose one compact LLM tool:

```ts
background_task({
  action: "start" | "list" | "read" | "stop" | "clear",
  command?: string,
  id?: string,
})
```

Infer the working directory, title, notification behavior, and log policy. Keep `/bg`, its shortcut, task dashboard, live task list, output viewer, process-group cleanup, output notifications, and bounded logs. Defer exit follow-ups while the parent is running and discard them when the task is cleared before delivery.

Remove the installer and obsolete session-tree compatibility paths.

### LSP

```ts
lsp_diagnostics({ paths?: string[], server?: string })
lsp_fix({ path: string, action?: string, apply?: boolean })
```

Infer workspace root, file limit, and unambiguous server routes. Keep configurable commands, environment overrides, JSON-RPC lifecycle, diagnostics, code actions, and workspace edits. Remove legacy migration and the `/lsp` status UI.

### Question

```ts
question({ question: string, options: string[] })
```

Use Pi's standard selection and input UI. Remove the custom editor and renderer.

### Goal

Keep the safety-sensitive terminal interfaces:

```ts
goal_complete({ goal_id: string, summary: string })
goal_blocked({
  goal_id: string,
  reason: string,
  evidence: string,
  repeated_turns: number,
})
```

Keep one active goal, `/goal` start/show/pause/resume/clear, persistence, stale-ID protection, prompt injection, automatic continuation, compaction survival, and bounded loop protection.

Remove queues, prioritization, token accounting, RPC, experimental modes, settings UI, and tool-visibility policy. Inject only goal ID, objective, status, and terminal-tool instructions on each turn.

## Provider extensions

### GitHub Copilot Auto

Keep:

- `github-copilot/auto`
- Dynamic `auto-*` model discovery
- Session and intent routing
- Forced discovered-model variants
- Required headers, token handling, cancellation, and timeout behavior

Rewrite as one provider wrapper with a small session cache.

### Anthropic OAuth

Keep OAuth login, refresh, and request/stream adaptation required for Claude Pro/Max. Prompt rewriting has one fixed behavior: path-safe replacement of standalone `Pi` while preserving paths and technical identifiers.

Remove aggressive, technical-safe, custom, and environment-selectable rewrite modes. Remove the `~/.Claude Code` symlink.

### Google Antigravity

Keep provider registration, public model definitions, OAuth login and refresh, and streaming through `@cortexkit/antigravity-auth-core`. Replace generated JavaScript with a small typed wrapper and avoid duplicating core protocol logic.

## Sensitive Guard

Keep:

- `/sensitive-guard` interactive configuration
- Enable/disable controls
- Read-redaction settings
- Content-scanning severity
- Protected-path configuration
- Read, write, edit, bash, and git-operation interception
- High-confidence secret detection
- Output redaction

Remove logs, debug events, legacy migration, command completion, and dynamic extension-module loading. Block messages must be concise and must never echo sensitive content.

## Direnv

Run `direnv export json` from the session working directory, merge the resulting environment, and report blocked `.envrc` files. Rely on direnv's own upward discovery instead of reproducing it.

## Source layout

Use flat, publisher-neutral extension directories. Repository documentation and Pi entrypoints identify an extension by its directory path rather than an attributed package name or version.

```text
extensions/
├── github-copilot-auto/
├── pi-anthropic-oauth/
├── pi-antigravity-auth/
├── pi-background-tasks/
├── pi-direnv/
├── pi-goal/
├── pi-lsp/
├── pi-sensitive-guard/
├── pi-subagents/
├── pi-web-access/
└── question/
```

Use `index.ts` as every extension entrypoint. Split only stateful or protocol-heavy code:

```text
extensions/<name>/
├── index.ts
├── runtime.ts      # optional
├── ui.ts           # optional
├── types.ts        # optional
└── LICENSE
```

Expected larger modules:

- `pi-web-access`: search, fetch, extract, storage, security, index
- `pi-subagents`: definitions, runner, manager, UI, worktree, index
- `pi-goal`: state, runtime, index
- `pi-lsp`: protocol, routing, index
- `pi-background-tasks`: runtime, UI, index
- `pi-sensitive-guard`: config, scanner, UI, index

## Dependencies

Prefer platform and Pi APIs over small utility packages. Expected removals:

- `@aliou/sh`
- `@sinclair/typebox`
- `croner`
- `nanoid`
- `p-limit`
- `promise.try`

Expected retained dependencies:

- `typebox`
- `@cortexkit/antigravity-auth-core`
- `@mozilla/readability`
- `linkedom`
- `turndown`
- `unpdf`

## Implementation order

1. Add registration, schema, context-size, and output-bound tests.
2. Define shared result limits and small utility functions.
3. Rewrite Question and Direnv.
4. Rewrite GitHub Copilot Auto and Google Antigravity.
5. Rewrite Anthropic OAuth with fixed path-safe rewriting.
6. Rewrite LSP and Goal.
7. Rewrite Sensitive Guard and its interactive configuration.
8. Rewrite Background Tasks with its dashboard.
9. Rewrite Web Access with OpenAI and Gemini only.
10. Rewrite Subagents, Markdown definitions, progressive skills, and UI.
11. Remove unused dependencies and regenerate the lockfile.
12. Run isolated Pi startup, tool-contract, provider, UI, cancellation, and security tests.

## Completion criteria

- All eleven extensions use flat `extensions/<name>/` paths and consistent TypeScript entrypoints.
- Default agents are `Plan`, `Explore`, `General`, and `Oracle`.
- Every agent explicitly declares tools in Markdown.
- Complex analysis is never recommended for the lightweight Explore model.
- Fresh context is the default; `fork` is explicit; `resume` and turn limits work.
- Agent and background-task UIs remain functional.
- OpenAI and Gemini search remain functional.
- Sensitive Guard remains interactively configurable.
- Anthropic rewriting is path-safe only.
- Full skill bodies are absent from startup context.
- Tool schemas and extension prompt text are materially smaller.
- Tool results are bounded and retrievable by ID where needed.
- `npm ci`, `npm run check`, extension import tests, and isolated Pi startup pass.
- Target source size is approximately 6,000–7,000 lines.
