export function delegationPrompt(
	definition: { description: string },
	title: string,
	task: string,
	context: string,
	cwd: string,
	forkText?: string,
): string {
	const base = [
		"# Delegated assignment",
		`Role: ${definition.description}`,
		`Working directory: ${cwd}`,
		"The parent conversation is not inherited. Work only from this explicit handoff and evidence you inspect yourself.",
		"",
		"## Task",
		`Title: ${title.trim()}`,
		task.trim(),
		"",
		"## Context from parent",
		context.trim(),
	].join("\n");
	const fork = forkText?.trim();
	if (!fork) return base;
	return `${base}\n\n## Parent conversation (read-only reference)\nVerify claims against files you inspect yourself.\n\n${fork}`;
}
