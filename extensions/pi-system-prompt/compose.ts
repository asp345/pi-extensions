import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const SKILL_FILE_TOOLS = ["read", "bash"] as const;
const FILE_PATHS_GUIDELINE = "Show file paths clearly when working with files";

function trimmed(value: string | undefined): string {
	return value?.trim() ?? "";
}

function normalizeCwd(cwd: string): string {
	return cwd.replace(/\\/g, "/");
}

// No phrasing-based filters by design: harness core generic guidelines never arrive
// via promptGuidelines (buildSystemPrompt adds them internally, and this path
// bypasses it). Only tool-registered strings arrive, so matching their wording
// would couple to third-party phrasing. A guideline fully contained in the base
// is dropped because restatement carries no information.
export function dedupeGuidelines(guidelines: readonly string[], baseText: string): string[] {
	const base = baseText.toLowerCase();
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const raw of guidelines) {
		const guideline = raw.trim();
		if (!guideline) continue;
		const key = guideline.toLowerCase();
		if (seen.has(key)) continue;
		if (key.length > 20 && base.includes(key)) continue;
		seen.add(key);
		kept.push(guideline);
	}
	if (!seen.has(FILE_PATHS_GUIDELINE.toLowerCase()) && !base.includes(FILE_PATHS_GUIDELINE.toLowerCase())) {
		kept.push(FILE_PATHS_GUIDELINE);
	}
	return kept;
}

export function filterContextFiles(
	files: readonly { path: string; content: string }[] | undefined,
	bases: readonly string[],
): { path: string; content: string }[] {
	if (!files?.length) return [];
	const normalizedBases = bases.map((base) => base.trim()).filter(Boolean);
	return files.filter((file) => {
		const content = file.content.trim();
		if (!content) return false;
		for (const base of normalizedBases) {
			if (content === base) return false;
			if (content.length > 50 && base.includes(content)) return false;
			if (base.length > 50 && content.includes(base)) return false;
		}
		return true;
	});
}

export function buildHarnessDocsBlock(packageDir: string | undefined): string | undefined {
	const dir = packageDir?.trim();
	if (!dir) return undefined;
	const clean = dir.replace(/\/+$/, "");
	return shortHarnessDocsBlock(`${clean}/README.md`, `${clean}/docs`, `${clean}/examples`);
}

export function extractHarnessDocsBlock(systemPrompt: string): string | undefined {
	const match = /Pi documentation \(read only when[\s\S]*?tui\.md for TUI API details\)/.exec(systemPrompt);
	return match?.[0];
}

export function resolveHarnessDocsBlock(systemPrompt: string, packageDir: string | undefined): string | undefined {
	const extracted = extractHarnessDocsBlock(systemPrompt);
	if (extracted) {
		const readme = /^- Main documentation: (.+)$/mu.exec(extracted)?.[1]?.trim();
		const docs = /^- Additional docs: (.+)$/mu.exec(extracted)?.[1]?.trim();
		const examples = /^- Examples: (.+?) \(extensions, custom tools, SDK\)$/mu.exec(extracted)?.[1]?.trim();
		if (readme && docs && examples) return shortHarnessDocsBlock(readme, docs, examples);
	}
	return buildHarnessDocsBlock(packageDir);
}

function shortHarnessDocsBlock(readme: string, docs: string, examples: string): string {
	return [
		"Harness documentation (only when the user asks about harness itself, its SDK, extensions, themes, skills, or TUI):",
		`- README: ${readme} | Docs: ${docs} | Examples: ${examples}`,
		"- Resolve docs/... under Docs and examples/... under Examples, never under the working directory.",
		"- Topic map: extensions, themes, skills, prompt-templates, tui, keybindings, sdk, custom-provider, models, packages, environment-variables (docs/<topic>.md).",
		"- Read the relevant files completely, following cross-references, before implementing.",
	].join("\n");
}

export function composeSystemPrompt(
	options: BuildSystemPromptOptions,
	harnessDocsBlock?: string,
	agentRules?: string,
): string | undefined {
	const customPrompt = trimmed(options.customPrompt);
	const baseRules = trimmed(agentRules);
	if (!baseRules) return undefined;

	const selectedTools = options.selectedTools ?? DEFAULT_TOOLS;
	const snippets = options.toolSnippets ?? {};
	const visibleTools = selectedTools.filter((name) => snippets[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n") : "(none)";

	const guidelines = dedupeGuidelines(options.promptGuidelines ?? [], `${customPrompt}\n${baseRules}`).map(
		(guideline) => `- ${guideline}`,
	);

	const contextFiles = filterContextFiles(options.contextFiles, [customPrompt, baseRules]);

	const sections: string[] = [];
	if (customPrompt) sections.push(customPrompt);
	if (baseRules) sections.push(baseRules);
	sections.push(
		[
			"Available tools:",
			toolsList,
			"",
			"In addition to the tools above, you may have access to other custom tools depending on the project.",
			"",
			"Guidelines:",
			...guidelines,
		].join("\n"),
	);
	if (harnessDocsBlock?.trim()) sections.push(harnessDocsBlock.trim());
	if (contextFiles.length > 0) {
		const body = contextFiles
			.map((file) => `<project_instructions path="${file.path}">\n${file.content.trim()}\n</project_instructions>`)
			.join("\n\n");
		sections.push(
			`<project_context>\n\nProject-specific instructions and guidelines:\n\n${body}\n\n</project_context>`,
		);
	}
	const skillFileReadTool = SKILL_FILE_TOOLS.find((tool) => selectedTools.includes(tool));
	const skillsBlock = (skillFileReadTool ? formatSkillsForPrompt(options.skills ?? [], skillFileReadTool) : "").trim();
	if (skillsBlock) sections.push(skillsBlock);
	sections.push(`Current working directory: ${normalizeCwd(options.cwd)}`);
	return sections.join("\n\n");
}
