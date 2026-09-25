import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { cloneItem, isJsonObject, isResponseItem, type JsonObject, type ResponseItem } from "./protocol.ts";
import { RetryableResponseError } from "./provider-request.ts";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";

export type RemoteCompactionResult = {
	compactionItem: ResponseItem;
	usage?: Usage;
};

export function buildCompactionRequestBody(payload: JsonObject, input: ResponseItem[]): JsonObject {
	const previousText = isJsonObject(payload.text) ? payload.text : undefined;
	const include = Array.isArray(payload.include)
		? payload.include.filter((value): value is string => typeof value === "string")
		: [];
	const body: JsonObject = {
		...payload,
		store: false,
		stream: true,
		input: [...input.map(cloneItem), { type: "compaction_trigger" }],
		tool_choice: "auto",
		parallel_tool_calls: true,
		include: [...new Set([...include, "reasoning.encrypted_content"])],
		text:
			previousText && typeof previousText.verbosity === "string"
				? { verbosity: previousText.verbosity }
				: { verbosity: "low" },
	};
	delete body.messages;
	delete body.previous_response_id;
	return body;
}

export function mergeFeatureHeader(existing: string | null | undefined): string {
	const features = (existing ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set([...features, REMOTE_COMPACTION_FEATURE])].join(",");
}

async function parseSseResponse(response: Response): Promise<{ item: ResponseItem; usage?: unknown }> {
	if (!response.body) throw new Error("OpenAI Codex returned an empty compaction stream.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	let usage: unknown;
	const compactionItems: ResponseItem[] = [];

	const processBlock = (block: string) => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			throw new Error("OpenAI Codex returned malformed compaction SSE data.");
		}
		if (!isJsonObject(event)) return;
		if (event.type === "error") {
			if (typeof event.message !== "string" || !event.message.trim()) {
				throw new RetryableResponseError("OpenAI Codex compaction failed.");
			}
			throw new Error(event.message);
		}
		if (event.type === "response.failed") {
			throw new Error("OpenAI Codex compaction ended with response.failed.");
		}
		if (event.type === "response.incomplete") {
			throw new RetryableResponseError("OpenAI Codex compaction ended with response.incomplete.");
		}
		if (event.type === "response.output_item.done" && isResponseItem(event.item) && event.item.type === "compaction") {
			compactionItems.push(event.item);
		}
		if (event.type === "response.completed" || event.type === "response.done") {
			completed = true;
			usage = isJsonObject(event.response) ? event.response.usage : undefined;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			processBlock(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) processBlock(buffer);
	if (!completed) {
		throw new RetryableResponseError("OpenAI Codex compaction stream closed before response.completed.");
	}
	if (compactionItems.length !== 1) {
		throw new Error(`OpenAI Codex returned ${compactionItems.length} compaction items; expected exactly one.`);
	}
	const item = compactionItems[0];
	if (!item || typeof item.encrypted_content !== "string") {
		throw new Error("OpenAI Codex returned a compaction item without encrypted_content.");
	}
	return { item, usage };
}

function usageFromResponse(model: Model<Api>, value: unknown): Usage | undefined {
	if (!isJsonObject(value)) return undefined;
	const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
	const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
	const details = isJsonObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
	const cacheWrite = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

export function readCodexCompactionResponse(
	model: Model<Api>,
): (response: Response) => Promise<RemoteCompactionResult> {
	return async (response) => {
		const parsed = await parseSseResponse(response);
		return { compactionItem: parsed.item, usage: usageFromResponse(model, parsed.usage) };
	};
}
