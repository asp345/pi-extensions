import { createHash } from "node:crypto";
import { extractAll, type ExtractedContent } from "./extract.ts";
import { search, type SearchOptions } from "./search.ts";
import { newId, type QueryResult, type SearchResult } from "./storage.ts";

export interface Passage {
	id: string;
	source: number;
	url: string;
	text: string;
	span?: { start: number; end: number };
	hash: string;
}
export interface ResearchArtifact {
	id: string;
	type: "research";
	createdAt: number;
	claim: string;
	status: "supported" | "contradicted" | "unclear" | "missing-evidence";
	confidence: number;
	rationale: string;
	sources: Array<SearchResult & { rank: number }>;
	passages: Passage[];
	supporting: string[];
	contradicting: string[];
	provider?: string;
	error?: string;
}

export async function checkSource(
	claim: string,
	fetchPages: boolean,
	options: SearchOptions,
): Promise<ResearchArtifact> {
	let result: QueryResult;
	try {
		result = await search(claim, { ...options, limit: 8 });
	} catch (error) {
		return artifact(claim, [], [], undefined, error instanceof Error ? error.message : String(error));
	}
	const sources = result.results.slice(0, 12);
	let pages: ExtractedContent[] = [];
	if (fetchPages && sources.length)
		pages = await extractAll(
			sources.slice(0, 5).map((source) => source.url),
			{},
			options.signal,
		);
	return artifact(claim, sources, pages, result.provider);
}

function artifact(
	claim: string,
	results: SearchResult[],
	pages: ExtractedContent[],
	provider?: string,
	error?: string,
): ResearchArtifact {
	const sources = results.map((source, index) => ({ ...source, rank: index + 1 }));
	const pageMap = new Map(pages.map((page) => [page.url, page]));
	const passages: Passage[] = [];
	for (const source of sources) {
		if (source.snippet.trim()) passages.push(makePassage(source.rank, source.url, source.snippet.trim()));
		const page = pageMap.get(source.url);
		if (!page?.content || page.error) continue;
		for (const span of relevantSpans(page.content, claim).slice(0, 3))
			passages.push(makePassage(source.rank, source.url, span.text, span.start, span.end));
	}
	const assessment = assess(claim, passages);
	return {
		id: newId(),
		type: "research",
		createdAt: Date.now(),
		claim,
		...assessment,
		sources,
		passages,
		...(provider ? { provider } : {}),
		...(error ? { error } : {}),
	};
}

function makePassage(source: number, url: string, text: string, start?: number, end?: number): Passage {
	const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
	return {
		id: `p${source}-${createHash("sha256").update(clean).digest("hex").slice(0, 8)}`,
		source,
		url,
		text: clean,
		...(start !== undefined && end !== undefined ? { span: { start, end } } : {}),
		hash: `sha256:${createHash("sha256").update(clean).digest("hex")}`,
	};
}

function relevantSpans(
	content: string,
	claim: string,
): Array<{ text: string; start: number; end: number; score: number }> {
	const terms = tokens(claim);
	const spans: Array<{ text: string; start: number; end: number; score: number }> = [];
	for (const match of content.matchAll(/[^.!?\n]+(?:[.!?]+|$)/g)) {
		const text = match[0].trim();
		if (text.length < 30 || text.length > 500) continue;
		const score = terms.filter((term) => text.toLowerCase().includes(term)).length;
		if (score) spans.push({ text, start: match.index, end: match.index + match[0].length, score });
	}
	return spans.sort((a, b) => b.score - a.score || a.start - b.start);
}

function assess(
	claim: string,
	passages: Passage[],
): Pick<ResearchArtifact, "status" | "confidence" | "rationale" | "supporting" | "contradicting"> {
	if (!passages.length)
		return {
			status: "missing-evidence",
			confidence: 0.2,
			rationale: "No source passages were available.",
			supporting: [],
			contradicting: [],
		};
	const terms = tokens(claim);
	const supporting: string[] = [];
	const contradicting: string[] = [];
	for (const passage of passages) {
		const text = passage.text.toLowerCase();
		const overlap = terms.filter((term) => text.includes(term)).length;
		if (overlap < Math.max(2, Math.ceil(terms.length / 4))) continue;
		const coverage = terms.length ? overlap / terms.length : 0;
		if (
			/\b(false|incorrect|debunked|denied|never|no longer|not true|contrary|cannot|does not|do not|is not|are not)\b/.test(
				text,
			)
		)
			contradicting.push(passage.id);
		else if (
			coverage >= 0.7 ||
			/\b(confirmed|verified|reported|shows|demonstrates|according to|is|are|was|were)\b/.test(text)
		)
			supporting.push(passage.id);
	}
	if (supporting.length && !contradicting.length)
		return {
			status: "supported",
			confidence: Math.min(0.85, 0.5 + supporting.length * 0.08),
			rationale: `${supporting.length} passage(s) support the claim.`,
			supporting,
			contradicting,
		};
	if (contradicting.length && !supporting.length)
		return {
			status: "contradicted",
			confidence: Math.min(0.85, 0.5 + contradicting.length * 0.08),
			rationale: `${contradicting.length} passage(s) contradict the claim.`,
			supporting,
			contradicting,
		};
	return {
		status: "unclear",
		confidence: 0.35,
		rationale:
			supporting.length || contradicting.length
				? "The source passages contain mixed evidence."
				: "The passages mention the topic without clear support or contradiction.",
		supporting,
		contradicting,
	};
}

function tokens(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((term) => term.length > 3),
		),
	];
}
