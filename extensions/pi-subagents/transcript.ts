import type { RpcMessage } from "./rpc.ts";
import { compact, contentText } from "./util.ts";

/** Bounded transcript: user/assistant text plus one-line tool status markers. */
export function compactTranscript(messages: readonly RpcMessage[]): string {
	const results = new Map<string, { error: boolean; summary: string }>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		results.set(message.toolCallId, {
			error: message.isError === true,
			summary: compact(contentText(message.content), 300),
		});
	}
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content).trim();
			if (text) lines.push(`User:\n${text}`);
		} else if (message.role === "assistant") {
			const text = contentText(message.content).trim();
			if (text) lines.push(`Assistant:\n${text}`);
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part.type !== "toolCall") continue;
				const name = toolName(part);
				const result = results.get(part.id);
				lines.push(
					result?.error
						? `[Tool ${name}: error: ${result.summary || "failed"}]`
						: `[Tool ${name}: ${result ? "ok" : "invoked"}]`,
				);
			}
		}
	}
	return lines.join("\n\n");
}

export function hasDamagedToolCall(messages: readonly RpcMessage[]): boolean {
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const name: unknown = part.name;
			if (typeof name !== "string" || !name.trim()) return true;
		}
	}
	return false;
}

function toolName(part: { name?: unknown }): string {
	return typeof part.name === "string" && part.name.trim() ? part.name : "(unnamed)";
}

export function lastAssistantText(messages: readonly RpcMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (text) return text;
	}
	return "";
}

export function finalError(messages: readonly RpcMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage?.trim() || "provider error";
		if (message.stopReason === "length" && !contentText(message.content).trim())
			return "output token limit reached before an answer";
		return undefined;
	}
	return undefined;
}
