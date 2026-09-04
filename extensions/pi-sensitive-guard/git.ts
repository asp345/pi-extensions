import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardConfig } from "./config.ts";
import { isProtectedPath } from "./config.ts";
import { scanSecrets } from "./scanner.ts";
import { gitAction } from "./shell.ts";

function addedDiff(diff: string): string {
	return diff
		.split(/\r?\n/)
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1))
		.join("\n");
}

function diffPaths(diff: string): string[] {
	return diff
		.split(/\r?\n/)
		.filter((line) => line.startsWith("+++ b/") || line.startsWith("--- a/"))
		.map((line) => line.slice(6).trim())
		.filter((path) => path && path !== "/dev/null");
}

async function gitDiffForAction(
	pi: ExtensionAPI,
	command: string,
	cwd: string,
	action: "commit" | "push",
): Promise<string> {
	const run = (args: string[]) => pi.exec("git", args, { cwd, timeout: 10_000 });
	if (action === "commit") {
		const staged = await run(["diff", "--cached", "--binary", "--no-ext-diff", "--relative"]);
		if (staged.code !== 0) throw new Error("staged diff failed");
		if (!/\bgit\s+commit\b[^\n;]*(?:\s-a\b|\s--all\b)/i.test(command)) return staged.stdout;
		const tracked = await run(["diff", "--binary", "--no-ext-diff", "--relative"]);
		if (tracked.code !== 0) throw new Error("tracked diff failed");
		return `${staged.stdout}\n${tracked.stdout}`;
	}

	let revs = await run(["rev-list", "--reverse", "@{upstream}..HEAD"]);
	if (revs.code !== 0) {
		revs = await run(["rev-list", "--reverse", "HEAD", "--not", "--remotes"]);
		if (revs.code !== 0) throw new Error("outgoing commit inspection failed");
	}
	const commits = revs.stdout.trim().split(/\s+/).filter(Boolean);
	const parts: string[] = [];
	for (const hash of commits.slice(0, 50)) {
		const shown = await run(["show", "--binary", "--no-ext-diff", "--format=", "--relative", hash]);
		if (shown.code !== 0) throw new Error("outgoing diff failed");
		parts.push(shown.stdout);
	}
	return parts.join("\n");
}

export async function inspectGit(
	pi: ExtensionAPI,
	command: string,
	cwd: string,
	config: GuardConfig,
): Promise<boolean> {
	if (!config.gitProtection.enabled) return false;
	const target = gitAction(command, cwd);
	if (
		!target ||
		(target.action === "commit" && !config.gitProtection.blockCommit) ||
		(target.action === "push" && !config.gitProtection.blockPush)
	)
		return false;
	const repo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: target.cwd, timeout: 10_000 });
	if (repo.code !== 0) return false;
	const diff = await gitDiffForAction(pi, command, target.cwd, target.action);
	if (diffPaths(diff).some((path) => isProtectedPath(path, target.cwd, config))) return true;
	return (
		config.contentScanning.enabled && scanSecrets(addedDiff(diff), config.contentScanning.blockSeverity).length > 0
	);
}
