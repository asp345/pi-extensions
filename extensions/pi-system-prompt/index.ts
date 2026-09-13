import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAgentRules } from "./agents.ts";
import { composeSystemPrompt, resolvePiDocsBlock } from "./compose.ts";

interface TurnRecord {
	length: number;
	startsWithRules: boolean;
	corePreamble: boolean;
}

function reportSystemPrompt(
	agentRules: string | undefined,
	lastTurn: TurnRecord | undefined,
	ctx: ExtensionCommandContext,
): string {
	const prompt = ctx.getSystemPrompt();
	const options = ctx.getSystemPromptOptions();
	const lines = [
		"last effective prompt (includes chained per-turn changes):",
		`  length: ${prompt.length} chars`,
		`  core preamble present: ${prompt.includes("You are an expert coding assistant")}`,
		`  appendSystemPrompt: ${options.appendSystemPrompt ? `${options.appendSystemPrompt.length} chars (in base; excluded from rebuild)` : "absent"}`,
		`last turn sent by this extension: ${
			lastTurn
				? `${lastTurn.length} chars, startsWithRules=${lastTurn.startsWithRules}, corePreamble=${lastTurn.corePreamble}`
				: agentRules
					? "no agent turn yet since load"
					: "no bundled rules loaded"
		}`,
		`tools: ${options.selectedTools?.length ?? 0} selected, ${Object.keys(options.toolSnippets ?? {}).length} snippets`,
		`guidelines: ${options.promptGuidelines?.length ?? 0} from extensions`,
		`contextFiles: ${(options.contextFiles ?? []).map((file) => file.path).join(", ") || "(none)"}`,
		`skills: ${(options.skills ?? []).map((skill) => skill.name).join(", ") || "(none)"}`,
		`customPrompt: ${options.customPrompt ? `${options.customPrompt.length} chars` : "absent"}`,
	];
	for (const marker of [
		"Available tools:",
		"Guidelines:",
		"Pi documentation",
		"<project_context>",
		"<available_skills>",
		"Current working directory:",
	]) {
		lines.push(`${marker} at ${prompt.indexOf(marker)} (effective)`);
	}
	return lines.join("\n");
}

export default function systemPromptExtension(pi: ExtensionAPI): void {
	let agentRules: string | undefined;
	try {
		agentRules = loadAgentRules();
	} catch {
		agentRules = undefined;
	}
	let lastTurn: TurnRecord | undefined;

	pi.registerCommand("system-prompt", {
		description: "Show how the current system prompt was composed",
		handler: async (_args, ctx) => {
			ctx.ui.notify(reportSystemPrompt(agentRules, lastTurn, ctx), "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!agentRules) return undefined;
		const piDocsBlock = resolvePiDocsBlock(event.systemPrompt, process.env.PI_PACKAGE_DIR);
		const systemPrompt = composeSystemPrompt(event.systemPromptOptions, piDocsBlock, agentRules);
		if (!systemPrompt || systemPrompt === event.systemPrompt) return undefined;
		lastTurn = {
			length: systemPrompt.length,
			startsWithRules: systemPrompt.startsWith(agentRules),
			corePreamble: systemPrompt.includes("You are an expert coding assistant"),
		};
		return { systemPrompt };
	});
}
