# pi-deepseek-search

Registers the `search` and `fetch` tools, backed by the [DeepSeek Search and Fetch APIs](https://api-docs.deepseek.com/guides/search/).

## Tools

- `search`: `POST https://api.deepseek.com/v1/tools/search` with `query`, `count`, `ori_question`, `localization`, and `need_content`. Each result shows title, URL, site name, date, authority, summary, and content when `need_content` is true.
- `fetch`: `POST https://api.deepseek.com/v1/tools/fetch` with `url`. Returns the page title, URL, and content as Markdown.

Output over 2000 lines or 50KB is truncated, and the full output is saved to a temporary file whose path is given in the result. HTTP errors are reported with the status and response body.

## Authentication

Uses the API key stored for the `deepseek` provider. Set it with `/login` and select DeepSeek.
