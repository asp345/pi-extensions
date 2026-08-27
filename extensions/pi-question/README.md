# pi-question

Interactive question tool for Pi. Tool `question { question, options: string[] }`.

In `tui` mode shows `ctx.ui.select` with options plus `Type something...` custom entry, then `ctx.ui.input` for custom. Returns `User selected: <choice>` or `User answered: <text>` or `User cancelled.` and `Interactive UI is unavailable.` outside tui.
