# pi-browser

Helium browser control for Pi over the Chrome DevTools Protocol. Ported from [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (MIT) as an extension: the Pi process holds one CDP WebSocket and a flat session per tab, so console and network events are recorded without a daemon.

Requires `helium` on `PATH`.

## Tool

`browser` with `action: tabs|open|close|navigate|snapshot|html|eval|click|type|key|screenshot|console|network|cookies|set_cookie|delete_cookie|cdp` and optional `tab`, `url`, `selector`, `code`, `text`, `x`, `y`, `id`, `clear`, `cookie`, `method`, `params`.

The tool description is one line that points to [`USAGE.md`](./USAGE.md); the model reads the per-action reference from that file before first use.

## Browser

- The first tool call reads `$PI_CODING_AGENT_DIR/helium/DevToolsActivePort` and attaches to a running Helium. If none is running, it launches `helium --user-data-dir=$PI_CODING_AGENT_DIR/helium --remote-debugging-port=0 --no-first-run --no-default-browser-check --headless` detached and waits up to 20 s for the port file.
- `session_shutdown` closes the WebSocket only; Helium keeps running and the next session attaches to it.
- Each tab the tool uses gets `Runtime`, `Log`, `Network`, and `Page` enabled. Console calls, uncaught exceptions, non-verbose log entries, and network requests (excluding `data:` URLs) are buffered per tab, up to 500 entries each.
- Output over 2000 lines or 50 KB is truncated; the full text is written to a temporary file named in the result.

## Command

- `/browser` or `/browser status`: mode (`headless`/`headed`), profile path, and tabs.
- `/browser launch [headless|headed]`: connects in the requested mode, restarting Helium when the running mode differs. The requested mode is also used for later relaunches in the same Pi process. Default `headless`.
- `/browser quit`: sends `Browser.close` and waits for the connection to close.
