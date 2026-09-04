export function delegationPrompt(
	definition: { description: string },
	title: string,
	task: string,
	context: string,
	cwd: string,
): string {
	return [
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
}
