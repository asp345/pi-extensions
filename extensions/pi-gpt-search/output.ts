import type { WebRunCommand } from "./commands.ts";
import type { SearchResponse, SearchResult } from "./normalize.ts";
import type { RefIndex } from "./provider.ts";

export interface FormattedToolOutput {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export function formatTerminalHyperlink(url: string, text: string): string {
	if (!url) return text;
	return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
}

export function cleanCitationMarkers(text: string, results: SearchResult[] = [], refIndex?: RefIndex): string {
	if (!text) return "";

	const refToEntryMap = new Map<string, { num: number; item: SearchResult }>();
	results.forEach((r, idx) => {
		const ref = r.ref_id || r.refId;
		if (ref) {
			refToEntryMap.set(ref, { num: idx + 1, item: r });
		}
	});

	const resolveUrl = (ref: string): string | undefined => refToEntryMap.get(ref)?.item.url ?? refIndex?.get(ref)?.url;

	// 1. Matches Codex private Unicode citation markers: \uE200cite\uE202<ref>\uE201 or cite<ref>
	// 1. Matches Codex private Unicode citation markers: \uE200cite\uE202<ref>\uE201 or bare cite<ref>.
	// PUA-delimited markers are rewritten directly. The bare form only counts when the
	// payload is a reference id (optionally with a † label), so ordinary words such as
	// "cited" or "excited" never match.
	const resolveCitation = (cleanInner: string): string => {
		if (cleanInner.includes("†")) {
			const parts = cleanInner.split("†");
			const label = parts.slice(1).join("†").trim();
			return label ? `[${label}]` : "";
		}

		if (refToEntryMap.has(cleanInner)) {
			const entry = refToEntryMap.get(cleanInner)!;
			const label = `[${entry.num}]`;
			return entry.item.url ? formatTerminalHyperlink(entry.item.url, label) : label;
		}

		const matchedResult = results.find((r) => (r.ref_id || r.refId) === cleanInner);
		if (matchedResult && matchedResult.url) {
			const title = matchedResult.title ? matchedResult.title : matchedResult.url;
			return formatTerminalHyperlink(matchedResult.url, `[${cleanInner}: ${title}]`);
		}

		const indexUrl = refIndex?.get(cleanInner)?.url;
		if (indexUrl) {
			return formatTerminalHyperlink(indexUrl, `[${cleanInner}]`);
		}

		return `[${cleanInner}]`;
	};

	let cleaned = text.replace(
		/[\uE000-\uE2FF]cite[\uE000-\uE2FF]([^\uE000-\uE2FF\r\n]+)[\uE000-\uE2FF]/gi,
		(_match, inner: string) => resolveCitation(inner.trim()),
	);
	cleaned = cleaned.replace(/\bcite((?:turn\d+[a-z0-9_]*|\d+)(?:\u2020[^\r\n]*)?)/gi, (_match, inner: string) =>
		resolveCitation(inner.trim()),
	);

	// 2. Converts raw turn references like [turn0search0, turn2view0] into clickable OSC 8 hyperlink brackets [1] [2]
	cleaned = cleaned.replace(/\[(turn\d+[a-z0-9_,\s]*)\]/gi, (_match, inner: string) => {
		const refs = inner.split(",").map((s: string) => s.trim());
		const formattedRefs = refs.map((ref) => {
			if (refToEntryMap.has(ref)) {
				const entry = refToEntryMap.get(ref)!;
				const label = `[${entry.num}]`;
				return entry.item.url ? formatTerminalHyperlink(entry.item.url, label) : label;
			}
			const indexUrl = refIndex?.get(ref)?.url;
			if (indexUrl) {
				return formatTerminalHyperlink(indexUrl, `[${ref}]`);
			}
			return `[${ref}]`;
		});
		return formattedRefs.join(" ");
	});

	return cleaned;
}

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

export function formatWebToolResult(
	command: WebRunCommand,
	response: SearchResponse,
	refIndex?: RefIndex,
): FormattedToolOutput {
	let primaryText = "";

	if (typeof response.output === "string" && response.output.trim().length > 0) {
		primaryText = cleanCitationMarkers(response.output.trim(), response.results, refIndex);

		// Append formatted source reference list if results exist and aren't already formatted at end
		if (response.results && response.results.length > 0 && !primaryText.includes("Sources:")) {
			// Keep each entry's position from the full result list so source numbers match
			// the inline citation numbers produced by cleanCitationMarkers.
			const sourcesList = response.results
				.map((r, index) => ({ r, index }))
				.filter((entry): entry is { r: SearchResult & { url: string }; index: number } => Boolean(entry.r.url))
				.slice(0, 10)
				.map(({ r, index }) => {
					const num = index + 1;
					const title = r.title ? r.title : r.url;
					const refStr = r.ref_id ? ` (${formatTerminalHyperlink(r.url, r.ref_id)})` : "";
					const clickableUrl = formatTerminalHyperlink(r.url, r.url);
					return `[${num}] ${title}${refStr} - ${clickableUrl}`;
				});

			if (sourcesList.length > 0) {
				primaryText += `\n\nSources:\n${sourcesList.join("\n")}`;
			}
		}
	} else if (response.results && response.results.length > 0) {
		const formatted = response.results.map((item, idx) => {
			const num = idx + 1;
			const title = item.title ? item.title : (item.url ?? `Result ${num}`);
			const clickableUrl = item.url ? formatTerminalHyperlink(item.url, item.url) : "";
			const urlLine = clickableUrl ? `   URL: ${clickableUrl}\n` : "";
			const refLabel = item.ref_id && item.url ? formatTerminalHyperlink(item.url, item.ref_id) : (item.ref_id ?? "");
			const refLine = refLabel ? `   Ref: [${num}] (${refLabel})\n` : "";
			const snippetLine = item.snippet ? cleanCitationMarkers(item.snippet, response.results, refIndex) : "";
			return `[${num}] ${title}\n${refLine}${urlLine}${snippetLine ? "   " + snippetLine : ""}`.trim();
		});
		primaryText = `Web Search Results:\n\n${formatted.join("\n\n")}`;
	} else {
		primaryText = "No output or structured web results returned.";
	}

	return {
		content: [
			{
				type: "text",
				text: primaryText,
			},
		],
		details: {
			command,
			outputLength: primaryText.length,
			resultCount: response.results ? response.results.length : 0,
			results: response.results,
			encrypted_output: response.encrypted_output,
			raw: response.raw,
		},
	};
}
