import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { compact, contentText } from "./util.ts";

/** Bounded transcript: user/assistant text plus one-line tool status markers. */
export function compactTranscript(session: AgentSession): string {
	const results = new Map<string, { error: boolean; summary: string }>();
	for (const message of session.messages) {
		if (message.role !== "toolResult") continue;
		results.set(message.toolCallId, {
			error: message.isError === true,
			summary: compact(contentText(message.content), 300),
		});
	}
	const lines: string[] = [];
	for (const message of session.messages) {
		if (message.role === "user") {
			const text = contentText(message.content).trim();
			if (text) lines.push(`User:\n${text}`);
		} else if (message.role === "assistant") {
			const text = contentText(message.content).trim();
			if (text) lines.push(`Assistant:\n${text}`);
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part.type !== "toolCall") continue;
				const result = results.get(part.id);
				lines.push(
					result?.error
						? `[Tool ${part.name}: error: ${result.summary || "failed"}]`
						: `[Tool ${part.name}: ${result ? "ok" : "invoked"}]`,
				);
			}
		}
	}
	return lines.join("\n\n");
}
