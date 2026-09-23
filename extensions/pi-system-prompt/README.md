# pi-system-prompt

Builds the harness system prompt from the bundled `SYSTEM.txt` rules instead of appending those rules to the harness core default prompt.

## Behavior

`before_agent_start` replaces `event.systemPrompt` with `composeSystemPrompt(event.systemPromptOptions, harnessDocsBlock, agentRules)`:

1. `customPrompt` (`SYSTEM.md`) when present
2. Bundled `SYSTEM.txt` rules as the base
3. `Available tools` from `selectedTools`/`toolSnippets`
4. `Guidelines` from `promptGuidelines` plus `Show file paths clearly when working with files`
5. Short Harness documentation block (paths taken from the core prompt when found, otherwise `PI_PACKAGE_DIR`)
6. `<project_context>` from `contextFiles`, excluding files already contained in the base
7. Skills via harness core exported `formatSkillsForPrompt`, excluding `disableModelInvocation`
8. `Current working directory`

The composed prompt is stored until the next `session_start`. `context_with_system` replaces the system messages of every provider request with one leading system message holding the stored prompt and the current tool declarations. Runs started by `pi.sendMessage(..., { triggerTurn: true })` (background task and subagent notifications) skip `before_agent_start`, so this keeps their request prefix identical to user-started runs. Before the first `before_agent_start` of a session, requests keep the harness core prompt.

`options.appendSystemPrompt` (`APPEND_SYSTEM.md`) is ignored. The nixos `xdg.configFile "pi/APPEND_SYSTEM.md"` mapping for harness is obsolete once this extension is active and should be removed there; while it remains, its content has no effect on harness.

## Overlap with harness core

| harness core default | This extension |
| --- | --- |
| `You are an expert coding assistant ...` | Dropped, `SYSTEM.txt` identity stays first |
| `Be concise in your responses` | Dropped, `SYSTEM.txt` writing rules are stricter |
| `Use bash/powershell for file operations ...` | Dropped, conflicts with `Prefer built-in tools over bash` |
| `Show file paths clearly ...` | Kept |
| `Available tools`, `In addition ...`, harness docs, `<project_context>`, skills, cwd | Kept and rebuilt from `systemPromptOptions` |

Extension `promptGuidelines` entries are kept except exact duplicates and lines restated verbatim in the base. No phrasing-based matching: harness core generic guidelines never arrive via `systemPromptOptions` (they are added inside `buildSystemPrompt`, which this path bypasses), so matching third-party wording would only add coupling. The remaining wording-coupled parser is the docs-path extraction in `resolveHarnessDocsBlock`, which degrades gracefully (core block → `PI_PACKAGE_DIR` → omit).

## Command

`/system-prompt` reports the last effective prompt (`agent.state.systemPrompt`, which keeps the chained per-turn result) plus the base inputs: the length of the stored composed prompt, whether it starts with the bundled `SYSTEM.txt`, whether the core preamble is present, tool/guideline counts, context file paths, skill names, and section offsets. Context file contents are never printed.

## Load order

This extension must run before per-turn prompt appenders so later `before_agent_start` handlers chain on top of the rebuilt prompt. It is listed first in root `package.json` `pi.extensions`.

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
