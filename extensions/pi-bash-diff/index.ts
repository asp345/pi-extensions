import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileChangeDetails } from "./details.ts";
import { captureSnapshot, changedFiles, type GitSnapshot, refreshFile } from "./snapshot.ts";

const MAX_CHANGED_FILES = 10;
const FILE_MUTATING_TOOLS = new Set(["edit", "write"]);

interface FileMutation {
	path: string;
	ended: Promise<void>;
	end: () => void;
}

function reportFailure(ctx: ExtensionContext, error: unknown): undefined {
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(`pi-bash-diff snapshot failed: ${message}`, "warning");
	return undefined;
}

export default function bashDiff(pi: ExtensionAPI): void {
	const snapshots = new Map<string, Promise<GitSnapshot | undefined>>();
	const mutations = new Map<string, FileMutation>();

	pi.on("tool_call", async (event, ctx) => {
		if (FILE_MUTATING_TOOLS.has(event.toolName)) {
			const path = "path" in event.input ? event.input.path : undefined;
			if (typeof path !== "string") return;
			const { promise, resolve: end } = Promise.withResolvers<void>();
			mutations.set(event.toolCallId, { path: resolve(ctx.cwd, path), ended: promise, end });
			return;
		}
		if (event.toolName !== "bash" || event.parentToolCallId || ctx.mode !== "tui") return;
		const snapshot = captureSnapshot(ctx.cwd).catch((error) => reportFailure(ctx, error));
		snapshots.set(event.toolCallId, snapshot);
		await snapshot;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const mutation = mutations.get(event.toolCallId);
		if (!mutation) return;
		mutations.delete(event.toolCallId);
		await Promise.all(
			[...snapshots.values()].map(async (pending) => {
				const snapshot = await pending;
				if (snapshot) await refreshFile(snapshot, mutation.path).catch((error) => reportFailure(ctx, error));
			}),
		);
		mutation.end();
	});

	pi.on("tool_result", async (event) => {
		const pending = snapshots.get(event.toolCallId);
		if (!pending) return;
		const snapshot = await pending;
		await Promise.all([...mutations.values()].map((mutation) => mutation.ended));
		snapshots.delete(event.toolCallId);
		if (!snapshot) return;
		const fileChanges = await changedFiles(snapshot);
		if (fileChanges.length === 0 || fileChanges.length >= MAX_CHANGED_FILES) return;
		const details: FileChangeDetails = { ...(event.details ?? {}), fileChanges };
		return { details };
	});

	const clear = () => {
		snapshots.clear();
		mutations.clear();
	};
	pi.on("agent_end", clear);
	pi.on("session_shutdown", clear);
}
