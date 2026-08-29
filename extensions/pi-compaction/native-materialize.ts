import { randomUUID } from "node:crypto";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "./config.ts";
import { withoutDeletedHeaders } from "./headers.ts";
import {
	buildCodexHeaders,
	buildCompactionRequestBody,
	buildMaterializationRequestBody,
	callRemoteCompaction,
	callRemoteMaterialization,
	findNativeCheckpoint,
	isOpenAICodexModel,
	messagesToResponseItems,
	type ResponseItem,
	resolveCodexResponsesUrl,
} from "./native-compaction.ts";

const COMPACTION_INSTRUCTIONS =
	"Create a native compaction checkpoint from the supplied conversation. Preserve every original conversation message byte-for-byte: exact wording, capitalization, punctuation, whitespace, identifiers, commands, paths, tool calls, tool results, and role order. Do not summarize, paraphrase, interpret, or continue the task. On the next turn, when asked for a dump, reproduce only the original conversation byte-for-byte in its original order.";

const MATERIALIZATION_INSTRUCTIONS =
	"Reproduce only the original conversation content byte-for-byte from the compacted state. Add nothing and do not continue the task.";

const MATERIALIZATION_PROMPT =
	"Dump the original conversation from the compacted state byte-for-byte in its original order. Output only the recovered conversation content. Preserve exact capitalization, punctuation, whitespace, commands, identifiers, paths, tool calls, and tool results. Do not add Markdown fences, explanations, advice, inferred actions, or commentary.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function combineUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first) return second;
	if (!second) return first;
	const reasoning =
		first.reasoning === undefined && second.reasoning === undefined
			? undefined
			: (first.reasoning ?? 0) + (second.reasoning ?? 0);
	const cacheWrite1h =
		first.cacheWrite1h === undefined && second.cacheWrite1h === undefined
			? undefined
			: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0);
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function fileDetails(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function previousSummaryItem(summary: string | undefined): ResponseItem[] {
	if (!summary) return [];
	return [
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: summary, annotations: [] }],
		},
	];
}

export default function registerNativeMaterialization(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const activeModel = ctx.model;
			const checkpoint = findNativeCheckpoint(event.branchEntries as SessionEntry[]);
			if (checkpoint.status !== "none") {
				if (isOpenAICodexModel(activeModel)) return;
				throw new Error("An OpenAI Codex native checkpoint requires its original OpenAI Codex model.");
			}

			const config = getConfig();
			if (config.textMode !== "native-materialize") return;
			if (config.nativeCodex && isOpenAICodexModel(activeModel)) return;
			if (!config.textModel) throw new Error("native-materialize requires textModel.");

			const model = ctx.modelRegistry.find(config.textModel.provider, config.textModel.id);
			if (!model) {
				throw new Error(
					`Configured native materialization model not found: ${config.textModel.provider}/${config.textModel.id}`,
				);
			}
			if (!isOpenAICodexModel(model)) {
				throw new Error("native-materialize requires an openai-codex model using openai-codex-responses.");
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? "OpenAI Codex authentication is unavailable." : auth.error);
			}
			const requestModel: Model<Api> = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
			const input = [
				...previousSummaryItem(event.preparation.previousSummary),
				...messagesToResponseItems(requestModel, convertToLlm(messages), pi.getAllTools(), {
					includeReasoning: false,
				}),
			];
			if (input.length === 0) throw new Error("There is no conversation content to materialize.");

			const compactionSessionId = randomUUID();
			const url = resolveCodexResponsesUrl(requestModel.baseUrl);
			const compactionBody = buildCompactionRequestBody({
				model: requestModel,
				input,
				instructions: COMPACTION_INSTRUCTIONS,
				sessionId: compactionSessionId,
			});
			compactionBody.reasoning = { effort: "none", summary: "auto" };
			const compacted = await callRemoteCompaction({
				url,
				headers: buildCodexHeaders({
					apiKey: auth.apiKey,
					headers: withoutDeletedHeaders(auth.headers),
					sessionId: compactionSessionId,
				}),
				body: compactionBody,
				model: requestModel,
				signal: event.signal,
			});

			const materializationSessionId = randomUUID();
			const materialized = await callRemoteMaterialization({
				url,
				headers: buildCodexHeaders({
					apiKey: auth.apiKey,
					headers: withoutDeletedHeaders(auth.headers),
					sessionId: materializationSessionId,
				}),
				body: buildMaterializationRequestBody({
					model: requestModel,
					input: [compacted.compactionItem],
					instructions: MATERIALIZATION_INSTRUCTIONS,
					prompt: MATERIALIZATION_PROMPT,
					sessionId: materializationSessionId,
				}),
				model: requestModel,
				signal: event.signal,
			});

			return {
				compaction: {
					summary: materialized.text,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: combineUsage(compacted.usage, materialized.usage),
					details: {
						...fileDetails(event.preparation.fileOps),
						kind: "openai-codex-native-materialization",
						model: `${requestModel.provider}/${requestModel.id}`,
					},
				},
			};
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`Native materialization failed: ${errorMessage(error)}`, "error");
			}
			return { cancel: true };
		}
	});
}
