import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { record, text } from "../shared/json.ts";
import { storeBlockReason, storePathBlockReason } from "./guard.ts";

function block(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}

export default function nixStoreGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		const input = record(event.input) ?? {};
		if (
			event.toolName === "read" ||
			event.toolName === "grep" ||
			event.toolName === "find" ||
			event.toolName === "ls"
		) {
			const reason = storePathBlockReason(text(input.path));
			return reason ? block(reason) : {};
		}
		if (event.toolName !== "bash" && event.toolName !== "background_task") return {};
		if (event.toolName === "background_task" && text(input.action) !== "start") return {};
		const reason = storeBlockReason(text(input.command));
		return reason ? block(reason) : {};
	});
}
