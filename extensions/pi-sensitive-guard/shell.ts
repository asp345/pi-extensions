import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { GuardConfig } from "./config.ts";
import { isProtectedPath } from "./config.ts";

interface ShellPart {
	command: string;
	words: string[];
}

const READ_COMMANDS = new Set(["cat", "less", "more", "head", "tail", "bat", "grep", "rg", "ag", "source", "."]);
const COPY_COMMANDS = new Set(["cp", "copy", "mv", "move", "install"]);
const MUTATE_COMMANDS = new Set([
	"tee",
	"touch",
	"truncate",
	"dd",
	"set-content",
	"add-content",
	"out-file",
	"sed",
	"perl",
	"rm",
	"unlink",
	"shred",
	"del",
	"erase",
	"remove-item",
	"trash",
	"trash-put",
]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const INLINE_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node|ruby|php|lua|perl|[gm]?awk)$/iu;
const INLINE_SCRIPT_FLAG = /^(?:-[A-Za-z]*[ce]|--eval|--execute|--command)$/iu;
const FILE_ACCESS =
	/\b(?:open|file|readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|remove|rename|truncate)\s*\(/u;
const DYNAMIC_PATH = /(?:\+|`|\bjoin\s*\(|\bconcat\s*\(|process\.env|os\.environ|\$\{|\$[A-Za-z_])/u;
const KNOWN_COMMANDS = new Set(["git", ...SHELL_COMMANDS, ...READ_COMMANDS, ...COPY_COMMANDS, ...MUTATE_COMMANDS]);
const TOKEN = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g;
const REDIRECT = /(?<![<>])(?:\d*(>>?|<)|(&>>?))\s*(["']?)([^\s;&|"']+)\3/g;
const SECRET_ENV =
	/\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*(?:\})?/i;

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

function isCandidateProtected(path: string | null, cwd: string, config: GuardConfig): boolean {
	return path === null || isProtectedPath(path, cwd, config);
}

function anyProtectedOperand(words: string[], cwd: string, config: GuardConfig): boolean {
	return pathCandidates(words).some((path) => isCandidateProtected(path, cwd, config));
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

export function inspectShell(
	command: string,
	cwd: string,
	config: GuardConfig,
): { blocked: boolean; protectedRead: boolean } {
	let protectedRead = false;
	for (const part of shellParts(command)) {
		if (READ_COMMANDS.has(part.command) && anyProtectedOperand(part.words, cwd, config)) protectedRead = true;
		if (COPY_COMMANDS.has(part.command)) {
			const operands = pathCandidates(part.words);
			if (operands.slice(0, -1).some((path) => isCandidateProtected(path, cwd, config))) protectedRead = true;
			if (operands.slice(-1).some((path) => isCandidateProtected(path, cwd, config)))
				return { blocked: true, protectedRead };
		}
		if (MUTATE_COMMANDS.has(part.command) && anyProtectedOperand(part.words, cwd, config))
			return { blocked: true, protectedRead };
		if (part.command === "git") {
			const action = commandName(part.words[0] ?? "");
			const operands = part.words.slice(1);
			if (action === "clean") return { blocked: true, protectedRead };
			if (["rm", "checkout", "restore", "reset"].includes(action) && anyProtectedOperand(operands, cwd, config)) {
				return { blocked: true, protectedRead };
			}
			if (["show", "cat-file"].includes(action)) {
				const objectPaths = operands.map((word) => {
					const colon = word.indexOf(":");
					return colon >= 0 ? word.slice(colon + 1) : word;
				});
				if (anyProtectedOperand(objectPaths, cwd, config)) protectedRead = true;
			}
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
		if (!isCandidateProtected(target, cwd, config)) continue;
		if (operator.includes(">")) return { blocked: true, protectedRead };
		protectedRead = true;
	}
	if (SECRET_ENV.test(command) && /\b(?:echo|printf|env|printenv|set|cat)\b/i.test(command)) protectedRead = true;
	return { blocked: false, protectedRead };
}

export function gitAction(command: string, cwd: string): { action: "commit" | "push"; cwd: string } | undefined {
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
