import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

const FILE_PATHS_GUIDELINE = "Show file paths clearly when working with files";

export interface HarnessDocsPaths {
	readme: string;
	docs: string;
	examples: string;
}

function trimmed(value: string | undefined): string {
	return value?.trim() ?? "";
}

// No phrasing-based filters by design: only tool-registered and extension strings
// arrive here, so matching their wording would couple to third-party phrasing.
// A guideline fully contained in the base is dropped because restatement carries
// no information.
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

export function harnessDocsBlock(paths: HarnessDocsPaths): string {
	return [
		"Harness documentation (only when the user asks about harness itself, its SDK, extensions, themes, skills, or TUI):",
		`- README: ${paths.readme} | Docs: ${paths.docs} | Examples: ${paths.examples}`,
		"- Resolve docs/... under Docs and examples/... under Examples, never under the working directory.",
		"- Topic map: extensions, themes, skills, prompt-templates, tui, keybindings, sdk, custom-provider, models, packages, environment-variables (docs/<topic>.md).",
		"- Read the relevant files completely, following cross-references, before implementing.",
	].join("\n");
}

export function composePromptOptions(
	options: NormalizedBuildSystemPromptOptions,
	agentRules: string,
	docs: HarnessDocsPaths,
): NormalizedBuildSystemPromptOptions {
	const customPrompt = trimmed(options.customPrompt);
	const rules = agentRules.trim();
	const base = [customPrompt, rules].filter(Boolean).join("\n\n");

	const visibleTools = options.selectedTools.filter((name) => options.toolSnippets[name]);
	const tools = [
		visibleTools.length > 0
			? visibleTools.map((name) => `- ${name}: ${options.toolSnippets[name]}`).join("\n")
			: "(none)",
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
	].join("\n");

	const guidelines = dedupeGuidelines(
		[...options.selectedTools.flatMap((name) => options.toolGuidelines[name] ?? []), ...options.promptGuidelines],
		base,
	);

	return {
		...options,
		customPrompt: base,
		appendSystemPrompt: "",
		contextFiles: filterContextFiles(options.contextFiles, [customPrompt, rules]),
		sections: {
			...options.sections,
			tools,
			rules: guidelines.map((guideline) => `- ${guideline}`).join("\n"),
			docs: harnessDocsBlock(docs),
		},
	};
}
