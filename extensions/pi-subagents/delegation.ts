export function delegationPrompt(title: string, task: string, context: string, cwd: string): string {
	return [
		"# Delegated assignment",
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
