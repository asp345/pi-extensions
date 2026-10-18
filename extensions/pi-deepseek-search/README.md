# pi-deepseek-search

Registers the `web_search` and `web_fetch` tools, backed by the [DeepSeek Search and Fetch APIs](https://api-docs.deepseek.com/guides/search/).

## Tools

- `web_search`: `POST https://api.deepseek.com/v1/tools/search` with `need_content: false`, once per query. The tool takes 1 to 5 `queries` and `count` (default 10), removes duplicate queries, runs them in parallel, merges the results round-robin by rank, removes duplicate URLs, and keeps the first `count`. Each result is one line with title, URL, snippet, and publication date.
- `web_fetch`: `POST https://api.deepseek.com/v1/tools/fetch` with `url`. Returns the page title, URL, and content as Markdown.

Output over 2000 lines or 50KB is truncated, and the full output is saved to a temporary file whose path is given in the result. HTTP errors are reported with the status and response body.

## Authentication

Uses the API key stored for the `deepseek` provider. Set it with `/login` and select DeepSeek.
