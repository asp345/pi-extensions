import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { storeBlockReason, storePathBlockReason } from "./guard.ts";

function inputRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function packageDir(): string | undefined {
	const value = process.env.PI_PACKAGE_DIR?.trim();
	return value && value.length > 0 ? value : undefined;
}

function block(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}

export default function nixStoreGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		const input = inputRecord(event.input);
		if (
			event.toolName === "read" ||
			event.toolName === "grep" ||
			event.toolName === "find" ||
			event.toolName === "ls"
		) {
			const reason = storePathBlockReason(text(input.path), packageDir());
			return reason ? block(reason) : {};
		}
		if (event.toolName !== "bash" && event.toolName !== "background_task") return {};
		if (event.toolName === "background_task" && text(input.action) !== "start") return {};
		const reason = storeBlockReason(text(input.command), packageDir());
		return reason ? block(reason) : {};
	});
}
