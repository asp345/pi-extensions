import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileChangeDetails } from "./details.ts";
import { captureSnapshot, changedFiles, type GitSnapshot } from "./snapshot.ts";

function reportFailure(ctx: ExtensionContext, error: unknown): undefined {
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(`pi-bash-diff snapshot failed: ${message}`, "warning");
	return undefined;
}

export default function bashDiff(pi: ExtensionAPI): void {
	const snapshots = new Map<string, Promise<GitSnapshot | undefined>>();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" || event.parentToolCallId || ctx.mode !== "tui") return;
		const snapshot = captureSnapshot(ctx.cwd).catch((error) => reportFailure(ctx, error));
		snapshots.set(event.toolCallId, snapshot);
		await snapshot;
	});

	pi.on("tool_result", async (event) => {
		const pending = snapshots.get(event.toolCallId);
		if (!pending) return;
		snapshots.delete(event.toolCallId);
		const snapshot = await pending;
		if (!snapshot) return;
		const fileChanges = await changedFiles(snapshot);
		if (fileChanges.length === 0) return;
		const details: FileChangeDetails = { ...(event.details ?? {}), fileChanges };
		return { details };
	});

	pi.on("agent_end", () => snapshots.clear());
	pi.on("session_shutdown", () => snapshots.clear());
}
