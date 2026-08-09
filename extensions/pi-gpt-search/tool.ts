import type { SearchResponse } from "./normalize.ts";

export function formatSearchResponseText(query: string, response: SearchResponse): string {
	if (!response.results || response.results.length === 0) {
		return `No web search results found for: "${query}".`;
	}

	const formattedResults = response.results.map((item, idx) => {
		const title = item.title ? item.title : item.url;
		const snippet = item.snippet ? `   ${item.snippet}` : "";
		return `${idx + 1}. ${title}\n   URL: ${item.url}${snippet ? "\n" + snippet : ""}`;
	});

	return `Search results for: "${query}"\n\n${formattedResults.join("\n\n")}`;
}
