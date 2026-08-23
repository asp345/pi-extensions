# pi-config

My personal Pi monorepo.

## Contents

### Extensions

- `extensions/github-copilot-auto/`
- `extensions/pi-anthropic-oauth/`
- `extensions/pi-antigravity-auth/`
- `extensions/pi-background-tasks/`
- `extensions/pi-compaction/`
- `extensions/pi-direnv/`
- `extensions/pi-goal/`
- `extensions/pi-gpt-search/`
- `extensions/pi-lsp/`
- `extensions/pi-openrouter-metadata/`
- `extensions/pi-setup-custom-providers/`
- `extensions/pi-sensitive-guard/`
- `extensions/pi-subagents/`
- `extensions/pi-usage/`
- `extensions/question/`

The included theme is `themes/flatland.json`.

`pi-setup-custom-providers` handles custom providers and their model metadata. It replaces the previously vendored setup wizard with a local implementation.

Use `/custom-model` to add, edit, remove, and discover providers such as OpenRouter, Novita, Modal, and other OpenAI-compatible services. Provider definitions are stored in Pi's `models.json`, and credentials stay in Pi's auth storage when configured through `/login`. The extension never writes `settings.json`, so the `/models` allow-list is unaffected.

Every configured provider registers a `refreshModels` callback, so Pi refreshes model metadata on session start, when `/model` opens, and on `pi update --models`. Each refresh queries the provider's own listing endpoint for context windows, output limits, reasoning support, image input, and pricing. Offline refreshes reuse the persisted catalog instead of issuing requests, repeats within 24 hours reuse the previous result, and a failed discovery keeps the configured list. Names, reasoning flags, and thinking maps set by hand are never overwritten, and models marked `manual` keep their limits.

Each reasoning model can carry a default thinking level and a map from Pi's levels to the values the provider expects, which is how `xhigh` and `max` become selectable for providers that support them.

`pi-openrouter-metadata` supplements Pi's built-in OpenRouter provider. It keeps the bundled catalog as an offline and compatibility baseline, then refreshes validated metadata for matching models from OpenRouter's public catalog. It persists validated overlays in `~/.config/pi/openrouter-metadata-store.json`, revalidates them after five minutes, and retains the previous catalog on failure.

`pi-compaction` selects OpenAI Codex native encrypted compaction or prompt-based text compaction through `pi-compaction.json`. Prompt-based compaction can use a fixed model, including `openai-codex/gpt-5.6-luna`, without sending a native `compaction_trigger`. Native mode checks context usage after each completed turn, stops the active run at 90%, stores the opaque checkpoint in Pi's compaction entry, and continues after compaction.

`pi-subagents` runs subagents inside the parent session. Agent Markdown declares models in priority order:

```yaml
models:
  - parent
  - anthropic/claude-fable-5
  - openrouter/minimax/minimax-m3
thinking: parent
```

`parent` inherits the parent session's current model or thinking level. Missing or unavailable models are skipped. If a model fails, the agent continues the existing session with the next available model without repeating completed tool actions. Later resumes retain the selected model unless the `Agent` call explicitly selects another model.

Each delegation requires a concrete task and an explicit context handoff. The extension adds the selected agent's role and working directory to that handoff; it does not copy the parent conversation unless `fork` is explicitly requested.

Bundled definitions live in `extensions/pi-subagents/agents/`; global overrides live in `~/.config/pi/agents/`.

`/agents` opens the workspace, and while agents run a widget below the editor lists them: `shift+↑↓`, or `↓` then enter on an empty editor, opens the selected one. The workspace is a centered, bordered overlay that leaves the parent session visible around its edges. Its conversation is fetched from the tail, PgUp/PgDn scroll it, and the embedded editor steers the running agent or resumes a finished one.

`pi-usage` adds a `/usage` command that fetches current provider usage limits on demand. It resolves the OAuth access token through `ctx.modelRegistry.getProviderAuth` (auto-refreshed) and reads account and project metadata from `auth.json`, then calls the provider usage endpoint: Anthropic `/api/oauth/usage`, OpenAI Codex `backend-api/wham/usage`, Google Antigravity `v1internal:fetchAvailableModels`, and xAI SuperGrok `cli-chat-proxy.grok.com/v1/billing`. No rate-limit headers are captured during normal model calls.

`pi-gpt-search` adds the `web` research harness tool plus a `/gpt-search` command. It calls the OpenAI Codex standalone search endpoint (`chatgpt.com/backend-api/codex/alpha/search`) directly with the ChatGPT Plus/Pro (Codex) OAuth token resolved through `ctx.modelRegistry.getProviderAuth("openai-codex")`, so the active model stays the only reasoning model and no GPT inference turn is billed. `web` runs multi-step research (`search_query`, `open`, `find`, `click`); a quick lookup passes just `search_query`. `/gpt-search` searches straight from the prompt line. The request never carries conversation history, project files, or system prompts.

## Development

```bash
nix develop
npm ci --ignore-scripts
npm run check
nix fmt
```

Install the package locally after dependencies are available:

```bash
pi install /absolute/path/to/pi-config
```

Run an offline extension startup check with:

```bash
pi --no-extensions -e . --offline --list-models >/dev/null
```
