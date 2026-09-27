# browser tool

The first call launches headless Helium with a dedicated profile (`$PI_CODING_AGENT_DIR/helium`) and remote debugging. Later calls reuse the running browser. When the user must act in the browser, such as logging in, ask the user to run `/browser launch headed`. That restarts Helium with a visible window on the same profile, so cookies and logins persist.

`tab` is a tab id prefix from `tabs`. Without `tab`, the last used tab is used, then the first tab, and a blank tab is created when none exists. Console and network events are recorded per tab only after the tool first uses that tab, up to 500 entries each.

| action | parameters | result |
|---|---|---|
| `tabs` | | Page tabs. `*` marks the last used tab. |
| `open` | `url?` | Opens a new tab, loads `url`, and waits for the load event. |
| `close` | `tab?` | Closes the tab. |
| `navigate` | `url`, `tab?` | Loads `url` and waits for the load event (30 s limit). |
| `snapshot` | `tab?` | Accessibility tree as `[role] name = "value"` lines. Prefer this for page structure. |
| `html` | `selector?`, `tab?` | `outerHTML` of the first match, or of the whole document. |
| `eval` | `code`, `tab?` | Evaluates a JavaScript expression in the page. Promises are awaited. Returns strings as-is and other values as JSON. Wrap statements in an IIFE. |
| `click` | `selector` or `x`+`y`, `tab?` | `selector`: scrolls the first match into view and clicks its center. `x`/`y`: clicks at CSS pixel coordinates. Uses real mouse events. |
| `type` | `text`, `tab?` | Inserts text at the focused element. Click the field first. |
| `key` | `text`, `tab?` | Presses one key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `PageUp`, `PageDown`, `Home`, `End`. |
| `screenshot` | `tab?` | PNG of the viewport. CSS px = image px / devicePixelRatio. |
| `console` | `clear?`, `tab?` | Console calls, uncaught exceptions, and browser log entries. `clear` empties the buffer after returning it. |
| `network` | `id?`, `clear?`, `tab?` | Without `id`: `requestId method status type url` lines. With `id`: request and response headers, request body, and response body. |
| `cookies` | `url?`, `tab?` | Cookies for `url`, or for the tab's current URL. Includes HttpOnly cookies. |
| `set_cookie` | `cookie`, `tab?` | `cookie` is a JSON object string of `Network.setCookie` fields (`name`, `value`, `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expires`, `url`). Without `url` or `domain`, it applies to the tab's URL. |
| `delete_cookie` | `cookie`, `tab?` | `cookie` is a JSON object string of `Network.deleteCookies` fields (`name`, `url`, `domain`, `path`). Without `url` or `domain`, it applies to the tab's URL. |
| `cdp` | `method`, `params?`, `tab?` | Sends a raw Chrome DevTools Protocol command on the tab session and returns the JSON result. `params` is a JSON object string with every required field of the method, e.g. `{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}` for `Emulation.setDeviceMetricsOverride`. |

Output longer than 2000 lines or 50 KB is truncated, and the full text is saved to a file named in the result.
