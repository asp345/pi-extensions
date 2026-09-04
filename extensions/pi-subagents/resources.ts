import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { definitionBody } from "./definitions.ts";
import type { AgentDefinition } from "./types.ts";
import { compact } from "./util.ts";

export function createLoader(
	definition: AgentDefinition,
	cwd: string,
	systemPrompt: () => string,
	settingsManager: SettingsManager,
): DefaultResourceLoader {
	const extensionSpec = Array.isArray(definition.extensions)
		? extensionSelection(definition.extensions, cwd)
		: undefined;
	const excluded = new Set(definition.excludeExtensions.map((name) => name.toLowerCase()));
	const loadAll = definition.extensions === true;
	const noExtensions = definition.extensions === false;
	type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
	const extensionsOverride: LoaderOptions["extensionsOverride"] =
		noExtensions || (loadAll && !excluded.size)
			? undefined
			: (current) => ({
					...current,
					extensions: current.extensions.filter((extension: { path: string }) => {
						const name = extensionName(extension.path);
						return !excluded.has(name) && (loadAll || extensionSpec?.names.has(name));
					}),
				});
	const selectedSkills = Array.isArray(definition.skills)
		? new Set(definition.skills.map((name) => name.toLowerCase()))
		: undefined;
	const skillsOverride: LoaderOptions["skillsOverride"] = selectedSkills
		? (current) => ({
				...current,
				skills: current.skills.filter((skill: { name: string }) => selectedSkills.has(skill.name.toLowerCase())),
			})
		: undefined;
	return new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions,
		additionalExtensionPaths: extensionSpec?.paths,
		extensionsOverride,
		noSkills: definition.skills === false,
		skillsOverride,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: systemPrompt,
		appendSystemPromptOverride: () => [],
	});
}

export function skillCatalog(loader: DefaultResourceLoader): string {
	return loader
		.getSkills()
		.skills.map((skill) => {
			const description = compact(String(skill.description ?? ""), 240);
			return `- ${skill.name}: ${description || "No description"} (${skill.filePath})`;
		})
		.join("\n");
}

export function buildSystemPrompt(definition: AgentDefinition, ctx: ExtensionContext, cwd: string): string {
	const body = definitionBody(definition);
	const bridge = `<sub_agent_context>
You are the selected ${definition.name} subagent. Work only on the assigned task.
Use direct tools instead of shell substitutes where practical. Be concise and report evidence.
</sub_agent_context>`;
	const environment = `<active_agent name="${escapeXml(definition.name)}"/>

# Environment
Working directory: ${cwd}`;
	const memory = definition.memory
		? `\n\n# Memory\nMemory scope: ${definition.memory}. Use ${memoryPath(definition, cwd)} when the task requires persistent memory; do not read it speculatively.`
		: "";
	if (definition.promptMode === "append") {
		return `${ctx.getSystemPrompt()}\n\n${bridge}\n\n${environment}\n\n<agent_instructions>\n${body}\n</agent_instructions>${memory}`;
	}
	return `${bridge}\n\n${environment}\n\n${body}${memory}`;
}

function memoryPath(definition: AgentDefinition, cwd: string): string {
	if (definition.memory === "user") return join(getAgentDir(), "agent-memory", definition.name, "MEMORY.md");
	if (definition.memory === "local") return join(cwd, ".agents", "memory", definition.name, "MEMORY.md");
	return join(cwd, ".pi", "agent-memory", definition.name, "MEMORY.md");
}

function extensionSelection(entries: string[], cwd: string): { names: Set<string>; paths: string[] } {
	const names = new Set<string>();
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.includes("/") || entry.includes("\\") || entry.startsWith("~")) {
			const expanded = entry === "~" || entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
			const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
			paths.push(path);
			names.add(extensionName(path));
		} else names.add(entry.toLowerCase());
	}
	return { names, paths };
}

function extensionName(path: string): string {
	const base = basename(path);
	return (
		base === "index.ts" || base === "index.js" ? basename(dirname(path)) : base.replace(/\.(?:ts|js)$/u, "")
	).toLowerCase();
}

function escapeXml(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}
