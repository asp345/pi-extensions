import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contentText, isRecord } from "./util.ts";

type SessionMessage = AgentSession["messages"][number];
type ContentMessage = Extract<SessionMessage, { content: unknown }>;

function isSessionMessage(value: unknown): value is ContentMessage {
	return isRecord(value) && typeof value.role === "string" && "content" in value;
}

/** Copy the parent conversation into the child session, truncated to a bounded tail. */
export function copyParentConversation(ctx: ExtensionContext, session: AgentSession): void {
	const manager = ctx.sessionManager as unknown as {
		buildContextEntries?: () => unknown[];
		getBranch: () => unknown[];
	};
	const entries = manager.buildContextEntries?.() ?? manager.getBranch();
	const messages = entries
		.flatMap<ContentMessage>((entry) => {
			if (!isRecord(entry)) return [];
			if (entry.type === "message" && isSessionMessage(entry.message)) return [entry.message];
			if (isSessionMessage(entry)) return [entry];
			if (entry.type === "compaction" && typeof entry.summary === "string") {
				return [
					{
						role: "user",
						content: [{ type: "text", text: `[Parent summary]\n${entry.summary}` }],
						timestamp: Date.now(),
					},
				];
			}
			return [];
		})
		.map(compactForkMessage);
	const summary = messages.find((message) => contentText(message.content).startsWith("[Parent summary]"));
	const tail: ContentMessage[] = [];
	let chars = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message === summary) continue;
		const size = JSON.stringify(message).length;
		if (tail.length && chars + size > 160_000) break;
		tail.unshift(message);
		chars += size;
	}
	const selected = summary ? [summary, ...tail] : tail;
	const resultIds = new Set(
		selected.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	const callIds = new Set<string>();
	for (const message of selected) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		message.content = message.content.filter((part) => part.type !== "toolCall" || resultIds.has(part.id));
		for (const part of message.content) if (part.type === "toolCall") callIds.add(part.id);
	}
	const consistent = selected.filter((message) => {
		if (message.role === "toolResult") return callIds.has(message.toolCallId);
		if (message.role === "assistant" && Array.isArray(message.content)) return message.content.length > 0;
		return true;
	});
	if (consistent.length) session.agent.state.messages = structuredClone(consistent);
}

function compactForkMessage(message: ContentMessage): ContentMessage {
	const copy = structuredClone(message);
	if (copy.role !== "toolResult" || !Array.isArray(copy.content)) return copy;
	copy.content = copy.content.map((part) =>
		part.type === "text" && typeof part.text === "string"
			? {
					...part,
					text: part.text.length > 4_000 ? `${part.text.slice(0, 4_000)}\n[Tool result truncated for fork]` : part.text,
				}
			: part.type === "image"
				? { type: "text", text: "[Image omitted from fork]" }
				: part,
	);
	return copy;
}
