import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { FileChange } from "./details.ts";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

const execFileAsync = promisify(execFile);

type Content = { kind: "text"; text: string } | { kind: "absent" } | { kind: "other" };

export interface GitSnapshot {
	root: string;
	head?: string;
	files: Map<string, Content>;
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
	const { stdout } = await execFileAsync("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
		cwd,
		encoding: "buffer",
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
	});
	return stdout;
}

function fromBytes(bytes: Buffer): Content {
	if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return { kind: "other" };
	return { kind: "text", text: bytes.toString("utf8") };
}

async function readWorktree(path: string): Promise<Content | undefined> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || info.size > MAX_TEXT_BYTES) return { kind: "other" };
		if (!info.isFile()) return undefined;
		return fromBytes(await readFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
}

async function readHead(snapshot: GitSnapshot, path: string): Promise<Content> {
	if (!snapshot.head) return { kind: "absent" };
	const tree = (await git(snapshot.root, ["ls-tree", "-z", snapshot.head, "--", path])).toString("utf8");
	if (!tree) return { kind: "absent" };
	const [mode = "", type = "", object = ""] = tree.slice(0, tree.indexOf("\t")).split(" ");
	if (type !== "blob") return { kind: "absent" };
	if (mode === "120000") return { kind: "other" };
	return fromBytes(await git(snapshot.root, ["cat-file", "blob", object]));
}

async function dirtyPaths(root: string): Promise<string[]> {
	const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
	return status
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3));
}

export async function captureSnapshot(cwd: string): Promise<GitSnapshot | undefined> {
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).then(
		(stdout) => stdout.toString("utf8").trim() === "true",
		() => false,
	);
	if (!inside) return undefined;
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
	const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
		(stdout) => stdout.toString("utf8").trim(),
		() => undefined,
	);
	const files = new Map<string, Content>();
	await Promise.all(
		(await dirtyPaths(root)).map(async (path) => {
			const content = await readWorktree(join(root, path));
			if (content) files.set(path, content);
		}),
	);
	return { root, head, files };
}

function fileChange(path: string, before: Content, after: Content): FileChange | undefined {
	if (before.kind === "other" || after.kind === "other") return undefined;
	if (before.kind === "absent" && after.kind === "absent") return undefined;
	if (before.kind === "text" && after.kind === "text" && before.text === after.text) return undefined;
	const oldText = before.kind === "text" ? before.text : "";
	const newText = after.kind === "text" ? after.text : "";
	const { diff } = generateDiffString(oldText, newText);
	return diff ? { path, diff } : undefined;
}

export async function changedFiles(snapshot: GitSnapshot): Promise<FileChange[]> {
	const paths = [...new Set([...snapshot.files.keys(), ...(await dirtyPaths(snapshot.root))])].sort();
	const changes = await Promise.all(
		paths.map(async (path) => {
			const absolute = join(snapshot.root, path);
			const after = await readWorktree(absolute);
			if (!after) return undefined;
			const before = snapshot.files.get(path) ?? (await readHead(snapshot, path));
			return fileChange(absolute, before, after);
		}),
	);
	return changes.filter((change) => change !== undefined);
}
