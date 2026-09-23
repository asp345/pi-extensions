export function recoveryPrompt(prompt: string, transcript: string): string {
	const context = transcript.trim() ? transcript : "(no transcript survived from the previous attempt)";
	return [
		prompt.trim(),
		"",
		"## Recovered context",
		"The previous child session was damaged and cannot be reopened: its stored history contains an invalid tool call. Start over in a fresh session and do not reuse the old session file.",
		context,
	].join("\n");
}

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
