import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "./config.ts";
import {
	buildCompactionRequestBody,
	buildReplacementHistory,
	effectiveInputForBranch,
	findNativeCheckpoint,
	isJsonObject,
	isOpenAICodexModel,
	type JsonObject,
	mergeFeatureHeader,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	type ResponseItem,
	readCodexCompactionResponse,
} from "./native-compaction.ts";
import { requestThroughProvider, sessionReasoning } from "./provider-request.ts";

function localMarker(): string {
	return `OpenAI Codex native compaction checkpoint (${randomUUID()}).`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withInput(payload: JsonObject, input: ResponseItem[]): JsonObject {
	const next: JsonObject = { ...payload, input };
	delete next.messages;
	delete next.previous_response_id;
	return next;
}

function setFeatureHeader(headers: Record<string, string | null>): void {
	const existing = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-codex-beta-features");
	if (existing) {
		headers[existing[0]] = mergeFeatureHeader(existing[1]);
	} else {
		headers["x-codex-beta-features"] = mergeFeatureHeader(undefined);
	}
}

export default function codexCompactionExtension(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	const nativeCompactionConfigured = () => getConfig().nativeCodex;
	const activeTools = (): ToolInfo[] => {
		const names = new Set(pi.getActiveTools());
		return pi.getAllTools().filter((tool) => names.has(tool.name));
	};
	const checkpointInput = (branch: SessionEntry[], model: Model<Api>): ResponseItem[] | undefined => {
		if (findNativeCheckpoint(branch).status === "none") return undefined;
		return effectiveInputForBranch({ branch, model, tools: activeTools() });
	};

	pi.on("context", (event, ctx) => {
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status === "none") return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status === "none" && !nativeCompactionConfigured()) return;
		setFeatureHeader(event.headers);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;
		try {
			const input = checkpointInput(ctx.sessionManager.getBranch() as SessionEntry[], model);
			return input ? withInput(event.payload, input) : undefined;
		} catch (error) {
			ctx.abort();
			if (ctx.hasUI) {
				ctx.ui.notify(`OpenAI Codex request blocked: ${errorMessage(error)}`, "error");
			}
			return withInput(event.payload, []);
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!isOpenAICodexModel(model)) return undefined;

		const branch = event.branchEntries as SessionEntry[];
		const checkpoint = findNativeCheckpoint(branch);
		if (checkpoint.status === "none" && !nativeCompactionConfigured()) return undefined;

		try {
			let input: ResponseItem[] = [];
			const remote = await requestThroughProvider({
				ctx,
				model,
				context: { messages: convertToLlm(buildSessionContext(branch).messages) },
				signal: event.signal,
				reasoning: sessionReasoning(model, ctx.thinkingLevel),
				transport: "sse",
				headers: { "x-codex-beta-features": mergeFeatureHeader(undefined) },
				editPayload: (payload) => {
					input =
						checkpointInput(branch, model) ?? (Array.isArray(payload.input) ? payload.input.filter(isJsonObject) : []);
					return buildCompactionRequestBody(payload, input);
				},
				readResponse: readCodexCompactionResponse(model),
			});

			return {
				compaction: {
					summary: localMarker(),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: remote.usage,
					details: {
						kind: NATIVE_COMPACTION_KIND,
						version: NATIVE_COMPACTION_VERSION,
						modelKey: modelKey(model),
						replacementHistory: buildReplacementHistory(input, remote.compactionItem),
					},
				},
			};
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`OpenAI Codex native compaction failed: ${errorMessage(error)}`, "error");
			}
			return { cancel: true };
		}
	});
}
