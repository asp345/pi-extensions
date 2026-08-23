import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withoutDeletedHeaders } from "./headers.ts";
import { isOpenAICodexModel } from "./native-compaction.ts";

const COMMAND_INSTRUCTIONS = `In the \`## Critical Context\` section, preserve a \`Build & Run Commands\` subsection. Record the exact setup, install, build, test, run, and lint commands from successful bash tool calls verbatim. Preserve the working directory, required environment variables, prerequisites, and success criteria for each command. If a category has no applicable command, explicitly write \`none\`. If a command or any of its details has not been verified, explicitly write \`unknown\` instead of guessing. Do not invent, normalize, shorten, or replace commands with equivalent commands. Preserve existing command entries across later compactions unless a newer successful command supersedes one. Also write a \`Mistakes\` subsection to record previous mistakes.`;

type CompactionStream = NonNullable<Parameters<typeof compact>[7]>;

export default function registerTextCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) return;

		const model = ctx.model;
		if (!model) throw new Error("Cannot customize compaction without an active model.");

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);

		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const streamFn: CompactionStream = (streamModel, context, options) => {
			const provider = ctx.modelRegistry.getProvider(streamModel.provider);
			if (!provider) throw new Error(`Provider not found: ${streamModel.provider}`);
			return provider.streamSimple(streamModel, context, options);
		};
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
			ctx.thinkingLevel,
			streamFn,
			auth.env,
		);

		return { compaction: result };
	});
}
