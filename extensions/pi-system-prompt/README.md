# pi-system-prompt

Builds the pi system prompt from the bundled `SYSTEM.txt` rules instead of appending those rules to pi core's default prompt.

## Behavior

`before_agent_start` replaces `event.systemPrompt` with `composeSystemPrompt(event.systemPromptOptions, piDocsBlock, agentRules)`:

1. `customPrompt` (`SYSTEM.md`) when present
2. Bundled `SYSTEM.txt` rules as the base
3. `Available tools` from `selectedTools`/`toolSnippets`
4. `Guidelines` from `promptGuidelines` plus `Show file paths clearly when working with files`
5. Short Pi documentation block (paths taken from pi core's prompt when found, otherwise `PI_PACKAGE_DIR`)
6. `<project_context>` from `contextFiles`, excluding files already contained in the base
7. Skills via pi core's exported `formatSkillsForPrompt`, excluding `disableModelInvocation`
8. `Current working directory`

`options.appendSystemPrompt` (`APPEND_SYSTEM.md`) is ignored; only the sections above contribute.

## Overlap with pi core

| pi core default | This extension |
| --- | --- |
| `You are an expert coding assistant ...` | Dropped, `SYSTEM.txt` identity stays first |
| `Be concise in your responses` | Dropped, `SYSTEM.txt` writing rules are stricter |
| `Use bash/powershell for file operations ...` | Dropped, conflicts with `Prefer built-in tools over bash` |
| `Show file paths clearly ...` | Kept |
| `Available tools`, `In addition ...`, pi docs, `<project_context>`, skills, cwd | Kept and rebuilt from `systemPromptOptions` |

Extension `promptGuidelines` entries are kept except exact duplicates and lines restated verbatim in the base. No phrasing-based matching: pi core's generic guidelines never arrive via `systemPromptOptions` (they are added inside `buildSystemPrompt`, which this path bypasses), so matching third-party wording would only add coupling. The remaining wording-coupled parser is the docs-path extraction in `resolvePiDocsBlock`, which degrades gracefully (core block → `PI_PACKAGE_DIR` → omit).

## Command

`/system-prompt` reports the last effective prompt (`agent.state.systemPrompt`, which keeps the chained per-turn result) plus the base inputs: whether the sent turn started with the bundled `SYSTEM.txt`, whether the core preamble is present, tool/guideline counts, context file paths, skill names, and section offsets. Context file contents are never printed.

## Load order

This extension must run before per-turn prompt appenders so later `before_agent_start` handlers chain on top of the rebuilt prompt. It is listed first in root `package.json` `pi.extensions`.

## Source of truth

On this branch `SYSTEM.txt` is maintained directly. Keep the flat `Label:` sections and the missing title.

## Verification

```bash
bun test extensions/pi-system-prompt/compose.test.ts
pi --no-extensions -e . --offline --list-models >/dev/null
```
