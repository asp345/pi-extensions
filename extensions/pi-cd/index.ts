import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

function defaultSessionDir(cwd: string): string {
	return join(getAgentDir(), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export default function cdExtension(pi: ExtensionAPI): void {
	pi.registerCommand("cd", {
		description: "Move the current session to another working directory",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(ctx.cwd, "info");
				return;
			}
			const target = resolve(ctx.cwd, expandHome(input));
			if (!existsSync(target) || !statSync(target).isDirectory()) {
				ctx.ui.notify(`Not a directory: ${target}`, "error");
				return;
			}
			if (target === ctx.cwd) return;

			await ctx.waitForIdle();
			const session = ctx.sessionManager;
			const oldFile = session.getSessionFile();
			const header = session.getHeader();
			if (!oldFile || !header) {
				ctx.ui.notify("/cd requires a persisted session", "error");
				return;
			}

			const currentDir = session.getSessionDir();
			const sessionDir = currentDir === defaultSessionDir(ctx.cwd) ? defaultSessionDir(target) : currentDir;
			const newFile = join(sessionDir, basename(oldFile));
			const sameFile = newFile === oldFile;
			const content = [{ ...header, cwd: target }, ...session.getEntries()]
				.map((entry) => `${JSON.stringify(entry)}\n`)
				.join("");
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(newFile, content, { flag: sameFile ? "w" : "wx" });

			const result = await ctx.switchSession(newFile, {
				withSession: async (next) => {
					if (!sameFile) rmSync(oldFile, { force: true });
					next.ui.notify(next.cwd, "info");
				},
			});
			if (result.cancelled && !sameFile) rmSync(newFile);
		},
	});
}
