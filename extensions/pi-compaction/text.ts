import { compact, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "./config.ts";
import { withoutDeletedHeaders } from "./headers.ts";
import { findNativeCheckpoint, isOpenAICodexModel } from "./native-compaction.ts";

const COMMAND_INSTRUCTIONS = `In the \`## Critical Context\` section, preserve a \`Build & Run Commands\` subsection. Record the exact setup, install, build, test, run, and lint commands from successful bash tool calls verbatim. Preserve the working directory, required environment variables, prerequisites, and success criteria for each command. If a category has no applicable command, explicitly write \`none\`. If a command or any of its details has not been verified, explicitly write \`unknown\` instead of guessing. Do not invent, normalize, shorten, or replace commands with equivalent commands. Preserve existing command entries across later compactions unless a newer successful command supersedes one. Also write a \`Mistakes\` subsection to record previous mistakes.`;

type CompactionStream = NonNullable<Parameters<typeof compact>[7]>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function registerTextCompaction(pi: ExtensionAPI, getConfig: () => CompactionConfig): void {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const activeModel = ctx.model;
			const checkpoint = findNativeCheckpoint(event.branchEntries as SessionEntry[]);
			if (checkpoint.status !== "none") {
				if (isOpenAICodexModel(activeModel)) return;
				throw new Error("An OpenAI Codex native checkpoint requires its original OpenAI Codex model.");
			}

			const config = getConfig();
			if (config.nativeCodex && isOpenAICodexModel(activeModel)) return;

			const model = config.textModel
				? ctx.modelRegistry.find(config.textModel.provider, config.textModel.id)
				: activeModel;
			if (!model) {
				if (config.textModel) {
					throw new Error(
						`Configured text compaction model not found: ${config.textModel.provider}/${config.textModel.id}`,
					);
				}
				throw new Error("Cannot customize compaction without an active model.");
			}

			const provider = ctx.modelRegistry.getProvider(model.provider);
			if (!provider) throw new Error(`Provider not found for text compaction: ${model.provider}`);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const streamFn: CompactionStream = (streamModel, context, options) =>
				provider.streamSimple(streamModel, context, options);
			const customInstructions = event.customInstructions
				? `${event.customInstructions}\n\n${COMMAND_INSTRUCTIONS}`
				: COMMAND_INSTRUCTIONS;
			const result = await compact(
				event.preparation,
				requestModel,
				auth.apiKey,
				withoutDeletedHeaders(auth.headers),
				customInstructions,
				event.signal,
				config.textModel ? "off" : ctx.thinkingLevel,
				streamFn,
				auth.env,
			);

			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`Text compaction failed: ${errorMessage(error)}`, "error");
			}
			return { cancel: true };
		}
	});
}
