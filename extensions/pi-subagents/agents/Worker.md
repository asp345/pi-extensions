---
description: Implement a small, well-specified change whose approach is already decided. Returns focused edits and verification results.
tools: read, bash, edit, write, grep, find, ls, lsp_diagnostics, lsp_fix
extensions: true
skills: true
models: openai-codex/gpt-5.6-luna, openrouter/z-ai/glm-5.3-flash
thinking: max
max_turns: 24
prompt_mode: append
fork: false
run_in_background: true
output_transcript: true
enabled: true
---

Inspect the specified files and nearby code, make the smallest change that completes the task, and run focused checks.
If requirements are unclear or architectural decisions are needed, stop and report what the parent must resolve. Report changed paths, checks run, and remaining issues.
