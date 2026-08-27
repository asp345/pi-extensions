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

// Backend reference ids are minted per research turn as turn<turn><kind><index>:
// turn1search0, turn2view3. Citation rewriting and bracketed-list rewriting share
// this one grammar description.
const TURN_REF_SOURCE = String.raw`turn\d+[a-z0-9_]*`;
const CITATION_PUA_RE = /[\uE000-\uE2FF]cite[\uE000-\uE2FF]([^\uE000-\uE2FF\r\n]+)[\uE000-\uE2FF]/gi;
const CITATION_BARE_RE = new RegExp(String.raw`\bcite((?:${TURN_REF_SOURCE}|\d+)(?:†[^\r\n]*)?)`, "gi");
const BRACKETED_REFS_RE = new RegExp(String.raw`\[(${TURN_REF_SOURCE}[a-z0-9_,\s]*)\]`, "gi");

export function cleanCitationMarkers(text: string, results: SearchResult[] = [], refIndex?: RefIndex): string {
	if (!text) return "";

	const refToEntryMap = new Map<string, { num: number; item: SearchResult }>();
	results.forEach((r, idx) => {
		const ref = r.ref_id;
		if (ref) {
			refToEntryMap.set(ref, { num: idx + 1, item: r });
		}
	});

	// 1. Rewrites Codex private Unicode citation markers (\uE200cite\uE202<ref>\uE201)
	// and bare cite<ref> payloads. The bare form only counts when the payload is a
	// reference id (optionally with a † label), so ordinary words such as "cited" or
	// "excited" never match.
	const resolveCitation = (cleanInner: string): string => {
		if (cleanInner.includes("†")) {
			const parts = cleanInner.split("†");
			const label = parts.slice(1).join("†").trim();
			return label ? `[${label}]` : "";
		}

		if (refToEntryMap.has(cleanInner)) {
			const entry = refToEntryMap.get(cleanInner);
			if (!entry) return `[${cleanInner}]`;
			const label = `[${entry.num}]`;
			return entry.item.url ? formatTerminalHyperlink(entry.item.url, label) : label;
		}

		const matchedResult = results.find((r) => r.ref_id === cleanInner);
		if (matchedResult?.url) {
			const title = matchedResult.title ? matchedResult.title : matchedResult.url;
			return formatTerminalHyperlink(matchedResult.url, `[${cleanInner}: ${title}]`);
		}

		const indexUrl = refIndex?.get(cleanInner)?.url;
		if (indexUrl) {
			return formatTerminalHyperlink(indexUrl, `[${cleanInner}]`);
		}

		return `[${cleanInner}]`;
	};

	let cleaned = text.replace(CITATION_PUA_RE, (_match, inner: string) => resolveCitation(inner.trim()));
	cleaned = cleaned.replace(CITATION_BARE_RE, (_match, inner: string) => resolveCitation(inner.trim()));

	// 2. Converts raw turn references like [turn0search0, turn2view0] into clickable OSC 8 hyperlink brackets [1] [2]
	cleaned = cleaned.replace(BRACKETED_REFS_RE, (_match, inner: string) => {
		const refs = inner.split(",").map((s: string) => s.trim());
		const formattedRefs = refs.map((ref) => {
			if (refToEntryMap.has(ref)) {
				const entry = refToEntryMap.get(ref);
				if (!entry) return `[${ref}]`;
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

export function formatWebToolResult(
	command: WebRunCommand,
	response: SearchResponse,
	refIndex?: RefIndex,
): FormattedToolOutput {
	let primaryText = "";

	if (typeof response.output === "string" && response.output.trim().length > 0) {
		primaryText = cleanCitationMarkers(response.output.trim(), response.results, refIndex);

		// Append formatted source reference list if results exist and aren't already formatted at end.
		// Every url-bearing result is published: capping this footer hides the ref_id for
		// later display numbers, which forces the model to guess ids when opening documents.
		if (response.results && response.results.length > 0 && !primaryText.includes("Sources:")) {
			// Keep each entry's position from the full result list so source numbers match
			// the inline citation numbers produced by cleanCitationMarkers.
			const sourcesList = response.results
				.map((r, index) => ({ r, index }))
				.filter((entry): entry is { r: SearchResult & { url: string }; index: number } => Boolean(entry.r.url))
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
			return `[${num}] ${title}\n${refLine}${urlLine}${snippetLine ? `   ${snippetLine}` : ""}`.trim();
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
