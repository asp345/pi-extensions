import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type GuardConfig, isProtectedPath, loadConfig } from "./config.js";
import { redactOutput, scanSecrets } from "./scanner.js";
import { registerSensitiveGuardUI } from "./ui.js";

interface PendingRedaction {
	source: "read" | "bash";
}

interface ShellPart {
	command: string;
	words: string[];
}

const READ_COMMANDS = new Set(["cat", "less", "more", "head", "tail", "bat", "grep", "rg", "ag", "source", "."]);
const COPY_COMMANDS = new Set(["cp", "copy", "mv", "move", "install"]);
const WRITE_COMMANDS = new Set([
	"tee",
	"touch",
	"truncate",
	"dd",
	"set-content",
	"add-content",
	"out-file",
	"sed",
	"perl",
]);
const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "del", "erase", "remove-item", "trash", "trash-put"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const INLINE_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node|ruby|php|lua|perl|[gm]?awk)$/iu;
const INLINE_SCRIPT_FLAG = /^(?:-[A-Za-z]*[ce]|--eval|--execute|--command)$/iu;
const FILE_ACCESS =
	/\b(?:open|file|readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|remove|rename|truncate)\s*\(/u;
const DYNAMIC_PATH = /(?:\+|`|\bjoin\s*\(|\bconcat\s*\(|process\.env|os\.environ|\$\{|\$[A-Za-z_])/u;
const KNOWN_COMMANDS = new Set([
	"git",
	...SHELL_COMMANDS,
	...READ_COMMANDS,
	...COPY_COMMANDS,
	...WRITE_COMMANDS,
	...DELETE_COMMANDS,
]);
const TOKEN = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g;
const REDIRECT = /(?<![<>])(?:\d*(>>?|<)|(&>>?))\s*(["']?)([^\s;&|"']+)\3/g;
const SECRET_ENV =
	/\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*(?:\})?/i;

function inputRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function unquote(value: string): string {
	const stripped = value.replace(/^["'`]+|["'`,;]+$/g, "");
	return stripped.replace(/^\d*(?:>>?|<)+/, "");
}

function commandName(word: string): string {
	return basename(unquote(word)).toLowerCase();
}

function shellParts(command: string): ShellPart[] {
	const substitutions: string[] = [];
	const expanded = command.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_match, dollar, backtick) => {
		substitutions.push(String(dollar ?? backtick ?? ""));
		return "$(\u0000)";
	});
	return [expanded, ...substitutions]
		.flatMap((script) => script.split(/&&|\|\||[;|\n]/))
		.map((part) => {
			const words = part.match(TOKEN)?.map(unquote).filter(Boolean) ?? [];
			let index = words.findIndex(
				(word) => !word.includes("=") && !["sudo", "env", "command", "exec"].includes(commandName(word)),
			);
			if (index < 0) index = 0;
			return { command: commandName(words[index] ?? ""), words: words.slice(index + 1) };
		})
		.filter((part) => part.command.length > 0);
}

export function expandShellWord(word: string): string | null {
	if (word.includes("`") || word.includes("$(")) return null;
	let value = word;
	if (value === "~" || value.startsWith("~/")) value = `${homedir()}${value.slice(1)}`;
	else if (value.startsWith("~")) return null;
	value = value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(_match, braced?: string, plain?: string) => process.env[braced ?? plain ?? ""] ?? "",
	);
	return value.includes("${") ? null : value;
}

function pathCandidates(words: string[]): Array<string | null> {
	return words
		.filter((word) => word && !word.startsWith("-"))
		.map((word) => {
			const equals = word.indexOf("=");
			const raw = unquote(equals > 0 ? word.slice(equals + 1) : word);
			return raw ? expandShellWord(raw) : "";
		})
		.filter((path) => path !== "");
}

function candidateProtected(path: string | null, cwd: string, config: GuardConfig): boolean {
	return path === null || isProtectedPath(path, cwd, config);
}

function protectedCandidate(words: string[], cwd: string, config: GuardConfig): boolean {
	return pathCandidates(words).some((path) => candidateProtected(path, cwd, config));
}

function unsafeInlineFileAccess(part: ShellPart): boolean {
	if (!INLINE_INTERPRETER.test(part.command)) return false;
	const flag = part.words.findIndex((word) => INLINE_SCRIPT_FLAG.test(word));
	const script = flag >= 0 ? part.words[flag + 1] : undefined;
	return Boolean(script && FILE_ACCESS.test(script) && DYNAMIC_PATH.test(script));
}

function referencesProtected(part: ShellPart, cwd: string, config: GuardConfig): boolean {
	return [part.command, ...part.words]
		.flatMap((word) => word.split(/[\s"'()[\]{};,|&<>=]+/))
		.filter((token) => token && !token.startsWith("-") && !token.includes("://"))
		.filter((token) => token.includes("/") || token.includes(".") || token.startsWith("~") || token.includes("$"))
		.some((token) => {
			const expanded = expandShellWord(token);
			return expanded === null || (expanded !== "" && isProtectedPath(expanded, cwd, config));
		});
}

function inspectShell(command: string, cwd: string, config: GuardConfig): { blocked: boolean; protectedRead: boolean } {
	let protectedRead = false;
	for (const part of shellParts(command)) {
		if (READ_COMMANDS.has(part.command) && protectedCandidate(part.words, cwd, config)) protectedRead = true;
		if (COPY_COMMANDS.has(part.command)) {
			const operands = pathCandidates(part.words);
			if (operands.slice(0, -1).some((path) => candidateProtected(path, cwd, config))) protectedRead = true;
			if (operands.slice(-1).some((path) => candidateProtected(path, cwd, config)))
				return { blocked: true, protectedRead };
		}
		if (WRITE_COMMANDS.has(part.command) && protectedCandidate(part.words, cwd, config))
			return { blocked: true, protectedRead };
		if (DELETE_COMMANDS.has(part.command) && protectedCandidate(part.words, cwd, config))
			return { blocked: true, protectedRead };
		if (
			part.command === "git" &&
			["rm", "clean"].includes(commandName(part.words[0] ?? "")) &&
			protectedCandidate(part.words.slice(1), cwd, config)
		) {
			return { blocked: true, protectedRead };
		}
		if (SHELL_COMMANDS.has(part.command)) {
			const scriptIndex = part.words.findIndex((word) => /^-[A-Za-z]*c$/.test(word)) + 1;
			const script = scriptIndex > 0 ? part.words[scriptIndex] : undefined;
			if (script) {
				const inner = inspectShell(script, cwd, config);
				if (inner.protectedRead) protectedRead = true;
				if (inner.blocked) return { blocked: true, protectedRead };
			}
		}
		if (!KNOWN_COMMANDS.has(part.command) && (referencesProtected(part, cwd, config) || unsafeInlineFileAccess(part))) {
			return { blocked: true, protectedRead };
		}
	}

	for (const match of command.matchAll(REDIRECT)) {
		const operator = match[1] ?? match[2] ?? "";
		const target = expandShellWord(unquote(match[4] ?? ""));
		if (!candidateProtected(target, cwd, config)) continue;
		if (operator.includes(">")) return { blocked: true, protectedRead };
		protectedRead = true;
	}
	if (SECRET_ENV.test(command) && /\b(?:echo|printf|env|printenv|set|cat)\b/i.test(command)) protectedRead = true;
	return { blocked: false, protectedRead };
}

function replacementText(input: Record<string, unknown>): string {
	const chunks: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") chunks.push(value);
		else if (Array.isArray(value)) value.forEach(collect);
		else if (value && typeof value === "object") {
			const entry = value as Record<string, unknown>;
			for (const key of [
				"newText",
				"new_text",
				"text",
				"content",
				"lines",
				"edits",
				"set_line",
				"replace_lines",
				"insert_after",
				"replace",
			])
				collect(entry[key]);
		}
	};
	collect(input.newText);
	collect(input.new_text);
	collect(input.edits);
	return chunks.join("\n");
}

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

	const hashes = await run(["rev-list", "--reverse", "@{upstream}..HEAD"]);
	let commits = hashes.code === 0 ? hashes.stdout.trim().split(/\s+/).filter(Boolean) : [];
	if (hashes.code !== 0) {
		const unpushed = await run(["rev-list", "--reverse", "HEAD", "--not", "--remotes"]);
		if (unpushed.code !== 0) throw new Error("outgoing commit inspection failed");
		commits = unpushed.stdout.trim().split(/\s+/).filter(Boolean);
	}
	const parts: string[] = [];
	for (const hash of commits.slice(0, 50)) {
		const shown = await run(["show", "--binary", "--no-ext-diff", "--format=", "--relative", hash]);
		if (shown.code !== 0) throw new Error("outgoing diff failed");
		parts.push(shown.stdout);
	}
	return parts.join("\n");
}

function gitAction(command: string, cwd: string): { action: "commit" | "push"; cwd: string } | undefined {
	for (const part of shellParts(command)) {
		if (part.command !== "git") continue;
		let gitCwd = cwd;
		for (let index = 0; index < part.words.length; index++) {
			const word = part.words[index] ?? "";
			if (word === "-C" && part.words[index + 1]) {
				gitCwd = resolve(gitCwd, part.words[++index] as string);
				continue;
			}
			if (word.startsWith("-")) continue;
			if (word === "commit" || word === "push") return { action: word, cwd: gitCwd };
			break;
		}
	}
	return undefined;
}

async function inspectGit(pi: ExtensionAPI, command: string, cwd: string, config: GuardConfig): Promise<boolean> {
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

function block(ctx: ExtensionContext, reason: string): { block: true; reason: string } {
	if (ctx.hasUI) ctx.ui.notify(reason, "error");
	return { block: true, reason };
}

export default function sensitiveGuard(pi: ExtensionAPI): void {
	let config = loadConfig();
	const pending = new Map<string, PendingRedaction>();
	registerSensitiveGuardUI(pi, (next) => {
		config = next;
		pending.clear();
	});
	pi.on("session_start", () => {
		config = loadConfig();
		pending.clear();
	});
	pi.on("session_shutdown", () => pending.clear());

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled) return {};
		try {
			const input = inputRecord(event.input);
			const path = text(input.path);
			if (event.toolName === "read") {
				const protectedPath = isProtectedPath(path, ctx.cwd, config);
				if (config.readRedaction.enabled && (protectedPath || config.readRedaction.scope === "allOutput")) {
					pending.set(event.toolCallId, { source: "read" });
					return {};
				}
				return protectedPath ? block(ctx, "Sensitive Guard blocked a protected read.") : {};
			}

			if (event.toolName === "write" || event.toolName === "edit") {
				if (isProtectedPath(path, ctx.cwd, config)) return block(ctx, "Sensitive Guard blocked a protected write.");
				const content = event.toolName === "write" ? text(input.content) : replacementText(input);
				if (config.contentScanning.enabled) {
					const findings = scanSecrets(content, config.contentScanning.blockSeverity);
					if (findings.length)
						return block(
							ctx,
							`Sensitive Guard blocked secret-bearing content (${findings.map((finding) => finding.name).join(", ")}).`,
						);
				}
				return {};
			}

			if (event.toolName === "bash") {
				const command = text(input.command);
				if (await inspectGit(pi, command, ctx.cwd, config))
					return block(ctx, "Sensitive Guard blocked a git operation containing protected data.");
				const shell = inspectShell(command, ctx.cwd, config);
				if (shell.blocked) return block(ctx, "Sensitive Guard blocked a command targeting a protected path.");
				if (config.contentScanning.enabled && scanSecrets(command, config.contentScanning.blockSeverity).length) {
					return block(ctx, "Sensitive Guard blocked a command containing a secret.");
				}
				if (shell.protectedRead && !(config.readRedaction.enabled && config.readRedaction.includeShellOutput)) {
					return block(ctx, "Sensitive Guard blocked a protected shell read.");
				}
				if (
					config.readRedaction.enabled &&
					config.readRedaction.includeShellOutput &&
					(shell.protectedRead || config.readRedaction.scope === "allOutput")
				) {
					pending.set(event.toolCallId, { source: "bash" });
				}
			}
			return {};
		} catch {
			return block(ctx, "Sensitive Guard blocked the operation because its safety check failed.");
		}
	});

	pi.on("tool_result", (event) => {
		if (!pending.delete(event.toolCallId) || event.isError) return {};
		const content = event.content.map((part) => {
			if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") return part;
			const item = part as { type: "text"; text: string; [key: string]: unknown };
			return { ...item, text: redactOutput(item.text, config.readRedaction) };
		});
		return { content };
	});
}

export { inspectShell, isProtectedPath, loadConfig, redactOutput, scanSecrets };
