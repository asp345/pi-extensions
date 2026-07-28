import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractAll } from "./extract.ts";
import { checkSource, type ResearchArtifact } from "./fetch.ts";
import { search } from "./search.ts";
import {
	boundedText,
	clear,
	errorMessage,
	get,
	MAX_SLICE_CHARS,
	newId,
	put,
	type QueryResult,
	type StoredRecord,
	sliceText,
} from "./storage.ts";

const Provider = Type.Union([Type.Literal("auto"), Type.Literal("openai"), Type.Literal("gemini")]);
const RecencySchema = Type.Union([
	Type.Literal("day"),
	Type.Literal("week"),
	Type.Literal("month"),
	Type.Literal("year"),
]);

export default function webAccess(pi: ExtensionAPI): void {
	pi.on("session_start", () => clear());
	pi.on("session_shutdown", () => clear());

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search up to four queries with OpenAI or Gemini and return a bounded cited answer stored for later retrieval.",
		parameters: Type.Object({
			queries: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
				minItems: 1,
				maxItems: 4,
				description: "Distinct search queries.",
			}),
			provider: Type.Optional(Provider),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Sources per query." })),
			recency: Type.Optional(RecencySchema),
			domains: Type.Optional(
				Type.Array(Type.String({ maxLength: 253 }), {
					maxItems: 20,
					description: "Allowed domains; prefix exclusions with -.",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, context) {
			const queries = params.queries.map((query) => query.trim()).filter(Boolean);
			const items: QueryResult[] = [];
			for (const [index, query] of queries.entries()) {
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${index + 1}/${queries.length}` }],
					details: { progress: index / queries.length },
				});
				try {
					items.push(
						await search(query, {
							provider: params.provider,
							limit: params.limit,
							recency: params.recency,
							domains: params.domains,
							signal,
							context,
						}),
					);
				} catch (error) {
					if (signal?.aborted) throw error;
					items.push({ query, answer: "", results: [], error: errorMessage(error).slice(0, 1000) });
				}
			}
			const id = newId();
			put({ id, type: "search", createdAt: Date.now(), items });
			const raw = items.map(formatQuery).join("\n\n");
			return textResult(`${raw}\n\nStored as ${id}. Use get_search_content for slices.`, {
				id,
				queries: items.length,
				successful: items.filter((item) => !item.error).length,
			});
		},
	});

	pi.registerTool({
		name: "source_check",
		label: "Source Check",
		description: "Check one claim and return a bounded artifact with source URLs and exact passage citations.",
		parameters: Type.Object({
			claim: Type.String({ minLength: 1, maxLength: 4000, description: "Claim to verify." }),
			fetch: Type.Optional(Type.Boolean({ description: "Fetch up to five pages for exact passages." })),
		}),
		async execute(_id, params, signal, _onUpdate, context) {
			const artifact = await checkSource(params.claim.trim(), params.fetch === true, {
				provider: "auto",
				signal,
				context,
			});
			put({ id: artifact.id, type: "research", createdAt: artifact.createdAt, item: artifact });
			const raw = formatArtifact(artifact);
			return textResult(`${raw}\n\nStored as ${artifact.id}.`, {
				id: artifact.id,
				status: artifact.status,
				sources: artifact.sources.length,
				passages: artifact.passages.length,
			});
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Extract bounded HTML, PDF, GitHub, YouTube, or video content and store full slices for retrieval.",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
				minItems: 1,
				maxItems: 8,
				description: "Remote URLs or local video paths.",
			}),
			question: Type.Optional(Type.String({ maxLength: 4000, description: "Question for YouTube or video analysis." })),
			timestamp: Type.Optional(Type.String({ maxLength: 64, description: "Video time or start-end range." })),
			frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Video frames to extract." })),
		}),
		async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
			const urls = params.urls.map((url) => url.trim()).filter(Boolean);
			onUpdate?.({ content: [{ type: "text", text: `Fetching ${urls.length} item(s)` }], details: { progress: 0 } });
			const extracted = await extractAll(
				urls,
				{ question: params.question, timestamp: params.timestamp, frames: params.frames },
				signal,
			);
			const id = newId();
			const stored = extracted.map(({ images: _images, ...item }) => item);
			put({ id, type: "fetch", createdAt: Date.now(), items: stored });
			if (extracted.length === 1) {
				const item = extracted[0];
				if (item.error)
					return textResult(`Error: ${item.error}\n\nStored as ${id}.`, { id, successful: 0, error: item.error });
				const output = boundedText(`# ${item.title || item.url}\n\n${item.content}`);
				const content: AgentToolResult<Record<string, unknown>>["content"] = [];
				for (const image of item.images ?? [])
					content.push({ type: "image", data: image.data, mimeType: image.mimeType });
				content.push({
					type: "text",
					text: `${output.text}${output.truncated ? `\n\nContent continues in get_search_content({ id: "${id}", item: 0, offset: ${output.text.length} }).` : `\n\nStored as ${id}.`}`,
				});
				return {
					content,
					details: {
						id,
						successful: 1,
						chars: item.content.length,
						images: item.images?.length ?? 0,
						truncated: output.truncated,
					},
				};
			}
			const summary = extracted
				.map((item, index) =>
					item.error
						? `${index}. ${item.url}: error: ${item.error}`
						: `${index}. ${item.title || item.url} (${item.content.length} chars)`,
				)
				.join("\n");
			return textResult(`${summary}\n\nStored as ${id}. Select an item with get_search_content.`, {
				id,
				items: extracted.length,
				successful: extracted.filter((item) => !item.error).length,
			});
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve one bounded slice from stored search, source-check, or fetched content.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64, description: "Stored result ID." }),
			item: Type.Optional(Type.Integer({ minimum: 0, description: "Query or URL index." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLICE_CHARS, description: "Maximum characters." })),
		}),
		async execute(_id, params) {
			const record = get(params.id);
			if (!record) return textResult(`Error: no stored result ${params.id}`, { error: "not found", id: params.id });
			try {
				const selected = selectStored(record, params.item);
				if ("listing" in selected) return textResult(selected.listing, { id: params.id, type: record.type });
				const slice = sliceText(selected.text, params.offset ?? 0, params.limit ?? MAX_SLICE_CHARS);
				const suffix = slice.nextOffset === null ? "" : `\n\nNext offset: ${slice.nextOffset}`;
				return textResult(slice.text + suffix, {
					id: params.id,
					type: record.type,
					item: selected.item,
					offset: slice.offset,
					total: slice.total,
					nextOffset: slice.nextOffset,
					truncated: slice.truncated,
				});
			} catch (error) {
				return textResult(`Error: ${errorMessage(error)}`, { error: errorMessage(error), id: params.id });
			}
		},
	});
}

function selectStored(record: StoredRecord, item?: number): { text: string; item: number } | { listing: string } {
	if (record.type === "research") return { text: JSON.stringify(record.item, null, 2), item: 0 };
	if (item === undefined && record.items.length > 1) {
		if (record.type === "search") {
			return { listing: record.items.map((entry, index) => `${index}. ${entry.query}`).join("\n") };
		}
		return {
			listing: record.items
				.map((entry, index) => `${index}. ${entry.title || entry.url}${entry.error ? ` (error: ${entry.error})` : ""}`)
				.join("\n"),
		};
	}
	const index = item ?? 0;
	const selected = record.items[index];
	if (!selected) throw new Error(`item must be between 0 and ${Math.max(0, record.items.length - 1)}`);
	if (record.type === "search") return { text: formatQuery(record.items[index]), item: index };
	const fetched = record.items[index];
	return {
		text: `# ${fetched.title || fetched.url}\n\n${fetched.error ? `Error: ${fetched.error}` : fetched.content}`,
		item: index,
	};
}

function formatQuery(item: QueryResult): string {
	if (item.error) return `## ${item.query}\n\nError: ${item.error}`;
	const sources = item.results.length
		? item.results
				.map(
					(source, index) =>
						`${index + 1}. [${source.title}](${source.url})${source.snippet ? ` — ${source.snippet}` : ""}`,
				)
				.join("\n")
		: "No sources returned.";
	return `## ${item.query}${item.provider ? ` (${item.provider})` : ""}\n\n${item.answer}\n\n### Sources\n${sources}`;
}

function formatArtifact(artifact: ResearchArtifact): string {
	const lines = [
		`# Source check`,
		"",
		`Status: ${artifact.status} (${artifact.confidence.toFixed(2)})`,
		artifact.rationale,
		"",
	];
	if (artifact.passages.length) {
		lines.push("## Passages");
		for (const passage of artifact.passages) lines.push(`- [${passage.id}] ${passage.text}\n  ${passage.url}`);
	}
	if (artifact.sources.length) {
		lines.push("", "## Sources");
		for (const source of artifact.sources) lines.push(`${source.rank}. [${source.title}](${source.url})`);
	}
	if (artifact.error) lines.push("", `Error: ${artifact.error}`);
	return lines.join("\n");
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	const output = boundedText(text);
	return {
		content: [{ type: "text", text: output.text }],
		details: {
			truncated: output.truncated,
			...details,
			outputTruncated: output.truncated || details.truncated === true,
		},
	};
}
