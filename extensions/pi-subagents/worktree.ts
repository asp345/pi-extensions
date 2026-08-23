import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { WorktreeInfo } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function createWorktree(cwd: string, id: string): Promise<WorktreeInfo> {
	let root: string;
	let base: string;
	try {
		[root, base] = await Promise.all([
			gitAsync(cwd, ["rev-parse", "--show-toplevel"]),
			gitAsync(cwd, ["rev-parse", "HEAD"]),
		]);
	} catch {
		throw new Error("Worktree configuration error: the working directory must be in a Git repository with a commit.");
	}
	const subdir = relative(realpathSync(root), realpathSync(cwd));
	const target = join(tmpdir(), `pi-agent-${id.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
	try {
		await gitAsync(cwd, ["worktree", "add", "--detach", target, "HEAD"], 30_000);
	} catch (error) {
		try {
			await gitAsync(cwd, ["worktree", "remove", "--force", target]);
		} catch {}
		try {
			await gitAsync(cwd, ["worktree", "prune"]);
		} catch {}
		throw error;
	}
	return {
		root: target,
		cwd: subdir ? join(target, subdir) : target,
		branch: `pi-agent-${id.slice(0, 12)}`,
		base,
	};
}

export function saveWorktree(worktree: WorktreeInfo, prompt: string): string | undefined {
	if (!existsSync(worktree.root)) return undefined;
	const dirty = git(worktree.root, ["status", "--porcelain"]);
	const head = git(worktree.root, ["rev-parse", "HEAD"]);
	if (!dirty && head === worktree.base) return undefined;
	let branch = currentBranch(worktree.root);
	if (!branch) {
		branch = uniqueBranch(worktree.root, worktree.branch);
		git(worktree.root, ["switch", "-c", branch]);
	}
	if (dirty) {
		git(worktree.root, ["add", "-A"]);
		git(
			worktree.root,
			[
				"-c",
				"user.name=pi-subagent",
				"-c",
				"user.email=pi-subagent@localhost",
				"commit",
				"--no-verify",
				"-m",
				`pi-agent: ${compact(prompt, 160)}`,
			],
			30_000,
		);
	}
	worktree.branch = branch;
	return branch;
}

export function removeWorktree(parentCwd: string, worktree: WorktreeInfo): void {
	if (!existsSync(worktree.root)) return;
	try {
		git(parentCwd, ["worktree", "remove", "--force", worktree.root], 20_000);
	} catch {
		try {
			git(parentCwd, ["worktree", "prune"]);
		} catch {
			/* best effort */
		}
	}
}

function uniqueBranch(cwd: string, base: string): string {
	try {
		git(cwd, ["show-ref", "--verify", `refs/heads/${base}`]);
		return `${base}-${Date.now()}`;
	} catch {
		return base;
	}
}

function currentBranch(cwd: string): string | undefined {
	try {
		return git(cwd, ["symbolic-ref", "--short", "HEAD"]);
	} catch {
		return undefined;
	}
}

async function gitAsync(cwd: string, args: string[], timeout = 10_000): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, timeout });
	return stdout.trim();
}

function git(cwd: string, args: string[], timeout = 10_000): string {
	return execFileSync("git", args, { cwd, stdio: "pipe", timeout }).toString().trim();
}

function compact(value: string, limit: number): string {
	const text = value.replace(/\s+/gu, " ").trim();
	return text.length > limit ? text.slice(0, limit) : text;
}
