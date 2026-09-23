import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAgentRules } from "./agents.ts";
import { composeSystemPrompt, resolveHarnessDocsBlock } from "./compose.ts";

function reportSystemPrompt(
	agentRules: string | undefined,
	lastPrompt: string | undefined,
	ctx: ExtensionCommandContext,
): string {
	const prompt = ctx.getSystemPrompt();
	const options = ctx.getSystemPromptOptions();
	const lines = [
		"last effective prompt (includes chained per-turn changes):",
		`  length: ${prompt.length} chars`,
		`  core preamble present: ${prompt.includes("You are an expert coding assistant")}`,
		`  appendSystemPrompt: ${options.appendSystemPrompt ? `${options.appendSystemPrompt.length} chars (in base; excluded from rebuild)` : "absent"}`,
		`last prompt composed by this extension: ${
			lastPrompt && agentRules
				? `${lastPrompt.length} chars, startsWithRules=${lastPrompt.startsWith(agentRules)}, corePreamble=${lastPrompt.includes("You are an expert coding assistant")}`
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
		"Harness documentation",
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
	let lastPrompt: string | undefined;

	pi.registerCommand("system-prompt", {
		description: "Show how the current system prompt was composed",
		handler: async (_args, ctx) => {
			ctx.ui.notify(reportSystemPrompt(agentRules, lastPrompt, ctx), "info");
		},
	});

	pi.on("session_start", () => {
		lastPrompt = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		if (!agentRules) return undefined;
		const harnessDocsBlock = resolveHarnessDocsBlock(event.systemPrompt, process.env.PI_PACKAGE_DIR);
		const systemPrompt = composeSystemPrompt(event.systemPromptOptions, harnessDocsBlock, agentRules);
		if (!systemPrompt) return undefined;
		lastPrompt = systemPrompt;
		if (systemPrompt === event.systemPrompt) return undefined;
		return { systemPrompt };
	});

	pi.on("context_with_system", (event) => {
		if (!lastPrompt) return undefined;
		const current = getCurrentSystemMessage(event.messages);
		const head: SystemMessage = {
			role: "system",
			content: lastPrompt,
			...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
			timestamp: current?.timestamp ?? Date.now(),
		};
		return { messages: [head, ...event.messages.filter((message) => message.role !== "system")] };
	});
}
