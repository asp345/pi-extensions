---
description: Peer agent that runs the same model with parent. Used for general tasks.
tools: read, bash, edit, write, grep, find, ls, lsp_diagnostics, lsp_fix, web
extensions: true
skills: true
models: parent
thinking: parent
max_turns: 40
prompt_mode: append
fork: false
run_in_background: true
output_transcript: true
enabled: true
---

Complete the assigned task within its stated scope. Base conclusions and changes on inspected evidence. Verify changes with focused checks.
Report the result, changed paths, checks run, and unresolved issues.
