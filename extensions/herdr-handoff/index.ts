import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// When pi starts outside herdr but a herdr server is reachable, hand the
// session off: close any stale pane still holding this session file, open a
// pane in the workspace for this cwd, relaunch `pi --session <file>` there
// once this process has exited, and shut this instance down. Disable with
// PI_HERDR_HANDOFF=0.

const runFile = promisify(execFile);

async function herdr<T>(args: string[]): Promise<T> {
	const { stdout } = await runFile("herdr", args, { timeout: 10_000 });
	return JSON.parse(stdout).result as T;
}

function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

interface Pane {
	pane_id: string;
	cwd?: string;
	workspace_id: string;
}

interface Agent {
	pane_id: string;
	agent_session?: { value?: string };
}

export default function herdrHandoff(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV === "1" || process.env.PI_HERDR_HANDOFF === "0") return;
		const socket = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
		if (!existsSync(socket)) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		try {
			const { agents } = await herdr<{ agents: Agent[] }>(["agent", "list"]);
			for (const agent of agents) {
				if (agent.agent_session?.value === sessionFile) await herdr(["pane", "close", agent.pane_id]);
			}
			const { panes } = await herdr<{ panes: Pane[] }>(["pane", "list"]);
			const workspaceId = panes.find((pane) => pane.cwd === ctx.cwd)?.workspace_id;
			let paneId: string;
			if (workspaceId) {
				const created = await herdr<{ root_pane: { pane_id: string } }>([
					"tab",
					"create",
					"--workspace",
					workspaceId,
					"--cwd",
					ctx.cwd,
					"--label",
					basename(ctx.cwd),
				]);
				paneId = created.root_pane.pane_id;
			} else {
				await herdr(["workspace", "create", "--cwd", ctx.cwd, "--label", basename(ctx.cwd)]);
				const refreshed = await herdr<{ panes: Pane[] }>(["pane", "list"]);
				const pane = refreshed.panes.find(
					(candidate) => candidate.cwd === ctx.cwd && !panes.some((old) => old.pane_id === candidate.pane_id),
				);
				if (!pane) throw new Error("workspace created but no pane found");
				paneId = pane.pane_id;
			}
			// Give the new pane's shell a moment to become ready for input.
			await new Promise((resolve) => setTimeout(resolve, 800));
			const command = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; exec pi --session ${quote(sessionFile)}`;
			await herdr(["pane", "run", paneId, command]);
			ctx.ui.notify(`Session handed off to herdr pane ${paneId}. Attach with: herdr`, "info");
			setTimeout(() => ctx.shutdown(), 1_200);
		} catch {
			// herdr unavailable or a step failed: keep running here.
		}
	});
}
