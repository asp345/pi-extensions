# pi-magpie-search

Registers the `web_search` and `web_fetch` tools, backed by the web search MCP server of the [Magpie](https://usemagpie.ai) gateway.

## Tools

- `web_search`: takes `query`. Returns numbered results with title, URL, and page excerpt.
- `web_fetch`: takes `url`, `max_chars` (default 20000, at most 100000), and `offset` (default 0). Returns the page text, with HTML converted to Markdown with links. A long page comes in parts, and the result gives the offset to read on from.

Each call is a JSON-RPC `tools/call` request sent with `POST` to `/mcp/magpie/web-search` on the host of the `magpie` provider's `baseUrl`. The provider's API key is sent as `Authorization: Bearer <key>`. Magpie runs the search with the search set in Magpie under Settings › Models › Web search.

Output over 2000 lines or 50KB is truncated, and the full output is saved to a temporary file whose path is given in the result. HTTP errors are reported with the status and response body, and tool errors with Magpie's message.

## Configuration

Requires a provider named `magpie` with at least one model in `models.json`, for example `"baseUrl": "http://127.0.0.1:3425/v1"`.
