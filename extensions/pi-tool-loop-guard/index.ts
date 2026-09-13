import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LoopGuard, loopBlockReason } from "./guard.ts";

export default function toolLoopGuard(pi: ExtensionAPI): void {
	const guard = new LoopGuard();
	const blockedCallIds = new Set<string>();

	pi.on("before_agent_start", () => guard.reset());

	pi.on("message_end", (event) => {
		const { message } = event;
		if (message.role !== "assistant") return;
		const hasText = message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
		if (hasText) guard.reset();
	});

	pi.on("tool_call", (event) => {
		if (guard.shouldBlock(event.toolName, event.input)) {
			blockedCallIds.add(event.toolCallId);
			return { block: true, reason: loopBlockReason(guard.chainLength()) };
		}
		return {};
	});

	pi.on("tool_result", (event) => {
		if (blockedCallIds.delete(event.toolCallId)) return;
		guard.record(event.toolName, event.input, event.content);
	});
}
