# pi-model-thinking

Remembers the thinking level chosen for each `provider/modelId` pair.

Pi applies `modelThinkingLevels` from `settings.json` at startup and whenever a model is selected. The extension patches `InteractiveMode.prototype.cycleThinkingLevel` (the thinking-cycle shortcut) and `InteractiveMode.prototype.selectThinkingLevel` (`/thinking`) once per process. After either runs, the session's current level is stored for the current model with `SettingsManager.setModelThinkingLevel`.

Other level changes are not stored: model switches, `--thinking`, the per-model entries in `/settings` (which already write `modelThinkingLevels`), RPC `set_thinking_level`, and `pi.setThinkingLevel` from extensions.

`cycleThinkingLevel`, `selectThinkingLevel`, `session`, and `settingsManager` are private members of `InteractiveMode`; check them when updating Pi.
