# pi-system-prompt

Replaces the harness core system prompt construction with one built from the bundled `SYSTEM.txt` rules.

## Behavior

The extension patches `AgentSession.prototype._rebuildSystemPrompt` once per process. After the original method builds the base prompt options, `composePromptOptions` replaces them:

| Option | Value |
| --- | --- |
| `customPrompt` | `SYSTEM.md` (when present), then the bundled `SYSTEM.txt` |
| `sections.tools` | `- <tool>: <snippet>` for each selected tool with a snippet, then `In addition to the tools above, you may have access to other custom tools depending on the project.` |
| `sections.rules` | `toolGuidelines` of the selected tools and `promptGuidelines`, without exact duplicates and without lines contained verbatim in the base, then `Show file paths clearly when working with files` |
| `sections.docs` | Short harness documentation block with the paths from `getReadmePath()`, `getDocsPath()`, and `getExamplesPath()` |
| `appendSystemPrompt` | Empty; `APPEND_SYSTEM.md` has no effect |
| `contextFiles` | Context files, excluding files already contained in `SYSTEM.md` or `SYSTEM.txt` |

Because `customPrompt` is set, the core builds no preamble, tools, rules, or docs of its own; it adds `<project_context>`, `<skills>`, and `<cwd>`. The rendered prompt is ordered `preamble`, `project_context`, `skills`, `cwd`, `tools`, `rules`, `docs`.

The composed options are the session's base options, so the same prompt is:

- stored as the structured sections of the transcript's system message,
- sent for runs started by a user prompt and for runs started by `pi.sendMessage(..., { triggerTurn: true })`,
- returned by `ctx.getSystemPrompt()` and recorded in compaction entries.

`_rebuildSystemPrompt` runs on session creation and whenever the active tools or the tool registry change, so the tools and rules sections follow the active tool set. `SYSTEM.txt` is read on each rebuild. Subagent sessions in the same process use the same patch.

`_rebuildSystemPrompt` and `_baseSystemPromptOptions` are private members of `AgentSession`; check them when updating Pi.

## Overlap with harness core

| harness core default | This extension |
| --- | --- |
| `You are an expert coding assistant ...` | Replaced by `SYSTEM.txt` |
| `Be concise in your responses` | Dropped |
| `Use bash/powershell for file operations ...` | Dropped, conflicts with `Prefer built-in tools over bash` |
| `Show file paths clearly ...` | Kept |
| Tool list, tool guidelines, harness docs | Rebuilt as the `tools`, `rules`, and `docs` sections |
| `<project_context>`, skills, cwd | Built by the core |

Guidelines are not filtered by phrasing; only exact duplicates and lines restated verbatim in the base are dropped.

## Command

`/system-prompt` reports the prompt length, whether it starts with the custom prompt, the section names, the number of selected tools and rules, the context file paths, and the skill names. Context file contents are never printed.

## Syncing rules

`SYSTEM.txt` tracks `../nixos/modules/features/AGENTS.md` but is formatted independently (flat `Label:` sections, no title). After changing the source, copy it over and re-apply that formatting:

```bash
cp ../nixos/modules/features/AGENTS.md extensions/pi-system-prompt/SYSTEM.txt
```

## Verification

```bash
bun test extensions/pi-system-prompt/compose.test.ts
pi --no-extensions -e . --offline --list-models >/dev/null
```
