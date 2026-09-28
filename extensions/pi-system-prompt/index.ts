import {
	AgentSession,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { loadAgentRules } from "./agents.ts";
import { composePromptOptions } from "./compose.ts";

const PATCHED = Symbol.for("pi-system-prompt:rebuild-patched");

interface SessionInternals {
	_baseSystemPromptOptions: NormalizedBuildSystemPromptOptions;
}

type RebuildSystemPrompt = (this: AgentSession, toolNames: string[]) => void;

function installRebuildPatch(): void {
	const prototype = AgentSession.prototype;
	if (Reflect.get(prototype, PATCHED) === true) return;
	const baseRebuild = Reflect.get(prototype, "_rebuildSystemPrompt") as RebuildSystemPrompt;
	const rebuild: RebuildSystemPrompt = function (toolNames) {
		baseRebuild.call(this, toolNames);
		const internals = this as unknown as SessionInternals;
		internals._baseSystemPromptOptions = composePromptOptions(internals._baseSystemPromptOptions, loadAgentRules(), {
			readme: getReadmePath(),
			docs: getDocsPath(),
			examples: getExamplesPath(),
		});
	};
	Reflect.set(prototype, "_rebuildSystemPrompt", rebuild);
	Reflect.set(prototype, PATCHED, true);
}

function reportSystemPrompt(ctx: ExtensionCommandContext): string {
	const prompt = ctx.getSystemPrompt();
	const options = ctx.getSystemPromptOptions();
	const sections = [...prompt.matchAll(/^<([a-z][a-z0-9_-]*)>$/gmu)].map((match) => match[1]);
	const rules = (options.sections?.rules ?? "").split("\n").filter(Boolean);
	return [
		`length: ${prompt.length} chars`,
		`starts with SYSTEM.txt rules: ${prompt.startsWith(options.customPrompt ?? "\u0000")}`,
		`sections: ${sections.join(", ") || "(none)"}`,
		`tools: ${options.selectedTools?.length ?? 0} selected`,
		`rules: ${rules.length} guidelines`,
		`contextFiles: ${(options.contextFiles ?? []).map((file) => file.path).join(", ") || "(none)"}`,
		`skills: ${(options.skills ?? []).map((skill) => skill.name).join(", ") || "(none)"}`,
	].join("\n");
}

export default function systemPromptExtension(pi: ExtensionAPI): void {
	loadAgentRules();
	installRebuildPatch();

	pi.registerCommand("system-prompt", {
		description: "Show how the current system prompt was composed",
		handler: async (_args, ctx) => {
			ctx.ui.notify(reportSystemPrompt(ctx), "info");
		},
	});
}
