# pi-browser

Helium browser control for Pi over the Chrome DevTools Protocol. Ported from [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (MIT) as an extension: the Pi process holds one CDP WebSocket and a flat session per tab, so console and network events are recorded without a daemon.

Requires `helium` on `PATH`.

## Tool

`browser` with `action: tabs|open|close|navigate|download|snapshot|html|eval|screenshot|console|network|cookies|click|type|key|set_cookie|delete_cookie|cdp` and optional `tab`, `url`, `selector`, `code`, `text`, `x`, `y`, `id`, `clear`, `cookie`, `method`, `params`, `timeout`.

The tool description lists each action with its parameters. `cookie` and `params` are JSON object strings so that value types survive tool-call serialization.

- `tab` is a target id prefix from `tabs`. Without it, the tool uses the tab this Pi session used last; if that tab is gone or the session has not used one, it opens a new tab. Tabs of other sessions are used only when named by `tab`.
- `timeout` is in seconds, default 30, maximum 2147483. It bounds each CDP command, the page load wait of `navigate`, the detach wait of `close`, and the start and completion waits of `download`.

## Download

`download(url)` saves the response of `url` in `~/Downloads/agent/` through the browser session, so cookies and IP-based access of the browser apply.

- While the download runs, the tab intercepts document responses (`Fetch.enable`, response stage). A 2xx main-frame response gets `Content-Disposition: attachment`, so PDFs and other inline documents are saved instead of displayed. The tab stays on its previous page.
- Downloads are saved under their GUID (`Browser.setDownloadBehavior` with `allowAndName`) and renamed to the suggested file name when complete. An existing name gets a ` (1)`, ` (2)`, ... suffix. The result is the saved path and size.
- A network error fails immediately. Any other response that does not start a download, such as a CAPTCHA page, shows a warning notification and keeps waiting until `timeout`, so the user can pass the check in the Helium window. The site's reload after the check is saved as the download.
- A download that does not complete within `timeout` is canceled.

The download directory is set browser-wide and stays set, so files downloaded by hand in the same Helium window also go to `~/Downloads/agent/` under GUID names.

## Browser

- The first tool call reads `$PI_CODING_AGENT_DIR/helium/DevToolsActivePort` and attaches to a running Helium. If none is running, it launches `helium --user-data-dir=$PI_CODING_AGENT_DIR/helium --remote-debugging-port=0 --disable-blink-features=AutomationControlled --no-first-run --no-default-browser-check` detached, adding `--headless` in headless mode, and waits up to 20 s for the port file.
- Launches are headed by default.
- `--disable-blink-features=AutomationControlled` makes `navigator.webdriver` report `false`. With remote debugging it reports `true`, and Cloudflare challenges do not pass.
- Several Pi sessions attach to the same Helium through the port file. Each session keeps its own tab selection and its own console and network buffers.
- `session_shutdown` closes the WebSocket only; Helium keeps running and the next session attaches to it.
- Each tab the tool uses gets `Runtime`, `Log`, `Network`, and `Page` enabled. Console calls, uncaught exceptions, non-verbose log entries, and network requests (excluding `data:` URLs) are buffered per tab, up to 500 entries each.
- Output over 2000 lines or 50 KB is truncated; the full text is written to a temporary file named in the result.

## Command

- `/browser` or `/browser status`: mode (`headless`/`headed`), profile path, and tabs.
- `/browser launch [headless|headed]`: connects in the requested mode, restarting Helium when the running mode differs. The requested mode is also used for later relaunches in the same Pi process. Default `headed`.
- `/browser quit`: sends `Browser.close` and waits for the connection to close.

Restarting or quitting Helium closes the tabs of every session attached to it.
