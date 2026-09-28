const PREVIEW_CHARS = 500;

export function delegationPrompt(task: string, context: string, cwd: string): string {
	return [
		"[task from parent]",
		"",
		`Working directory: ${cwd}`,
		"The parent conversation is not inherited. Work only from this explicit handoff and evidence you inspect yourself.",
		"The parent does not see your text output. Deliver your answer with send_message.",
		"",
		"## Task",
		task.trim(),
		"",
		"## Context from parent",
		context.trim(),
	].join("\n");
}

export function parentMessagePrompt(message: string): string {
	return `[message from parent]\n\n${message.trim()}\n\nIf this calls for an answer, deliver it with send_message.`;
}

export function childMessageContent(name: string, message: string): string {
	return `[message from child:${name}]\n\n${message.trim()}`;
}

export type NoticeKind = "no-reply" | "failed" | "cancelled";

export function noticeContent(kind: NoticeKind, name: string, body: string | undefined): string {
	const header =
		kind === "failed"
			? `[child-failed child:${name}]`
			: kind === "cancelled"
				? `[child-exited: cancelled child:${name}]`
				: `[child-exited: no-reply child:${name}]`;
	if (!body) return header;
	return kind === "no-reply" ? `${header}\n\nLast assistant text: ${body}` : `${header}\n\n${body}`;
}

export function preview(text: string | undefined): string | undefined {
	const value = text?.replace(/\s+/gu, " ").trim();
	if (!value) return undefined;
	return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS - 1)}…` : value;
}
