import { type Command, type ParsedScript, parse, type Word } from "unbash";

const MAX_SLEEP_SECONDS = 30;

const DURATION_RE = /^(\d+(?:\.\d+)?)([smhd])?$/;
const SUFFIX_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const FALLBACK_RE = /\bsleep\b((?:\s+[\w.]+)*)/g;
const QUOTED_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

interface SleepInspection {
	/** total evaluated seconds across all sleep invocations */
	totalSeconds: number;
	/** a sleep invocation whose arguments cannot be statically evaluated */
	hasUnknown: boolean;
}

const NO_SLEEP: SleepInspection = { totalSeconds: 0, hasUnknown: false };

function literalSeconds(text: string): number | null {
	if (text === "inf" || text === "infinity") return Infinity;
	const match = DURATION_RE.exec(text);
	if (!match) return null;
	const num = match[1];
	if (!num) return null;
	return parseFloat(num) * (SUFFIX_SECONDS[match[2] ?? "s"] ?? 1);
}

function formatSeconds(seconds: number): string {
	return Number.isFinite(seconds) ? `${seconds}s` : "inf";
}

const GUIDANCE =
	"Do not sleep to wait. Launch a background task and end the turn instead; you will be notified when it completes.";

// Text scan used when parsing is impossible or produced errors: catches literal
// sleeps in unparsed regions. May double-count sleeps also found in the AST;
// over-counting is the conservative direction for a blocking guard.
function regexInspection(command: string): SleepInspection {
	const state: SleepInspection = { ...NO_SLEEP };
	const unquoted = command.replace(QUOTED_RE, "");
	for (const match of unquoted.matchAll(FALLBACK_RE)) {
		const args = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
		if (args.length === 0 || args[0] === "--") continue;
		const raw = args[0];
		if (!raw) continue;
		const first = literalSeconds(raw);
		if (first === null) continue;
		let total = first;
		for (const arg of args.slice(1)) {
			const seconds = literalSeconds(arg);
			if (seconds === null) {
				state.hasUnknown = true;
				total = 0;
				break;
			}
			total += seconds;
		}
		state.totalSeconds += total;
	}
	return state;
}

/** Walk every command in the unbash AST, covering nested substitutions, function bodies, and heredoc bodies. */
function walkCommands(root: ParsedScript, checkCommand: (node: Command) => void, mergeFallback: () => void): void {
	const visited = new WeakSet<object>();
	const walk = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		if (visited.has(value)) return;
		visited.add(value);
		const node = value as Record<string, unknown>;
		if (node.type === "Command") checkCommand(value as Command);
		if (node.type === "Script" && Array.isArray(node.errors) && node.errors.length > 0) mergeFallback();
		if ("parts" in node) {
			const parts = (value as Word).parts;
			if (parts) for (const part of parts) walk(part);
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) {
				for (const item of child) walk(item);
			} else {
				walk(child);
			}
		}
	};
	walk(root);
}

/**
 * Inspect a shell command for `sleep` invocations. Walks the unbash AST,
 * including nested command substitutions, function bodies, and heredoc bodies,
 * and evaluates only literal durations. `sleep -- <seconds>` is a deliberate
 * opt-in form and is never blocked.
 */
function inspectSleep(command: string): SleepInspection {
	const state: SleepInspection = { ...NO_SLEEP };
	let root: ParsedScript;
	try {
		root = parse(command);
	} catch {
		return regexInspection(command);
	}
	let fallbackApplied = false;
	const mergeFallback = (): void => {
		if (fallbackApplied) return;
		fallbackApplied = true;
		const fallback = regexInspection(command);
		state.totalSeconds += fallback.totalSeconds;
		state.hasUnknown ||= fallback.hasUnknown;
	};
	const checkCommand = (node: Command): void => {
		if (node.name?.value !== "sleep") return;
		if (node.suffix[0]?.value === "--") return;
		let total = 0;
		for (const arg of node.suffix) {
			const seconds = literalSeconds(arg.value);
			if (seconds === null) {
				state.hasUnknown = true;
				return;
			}
			total += seconds;
		}
		state.totalSeconds += total;
	};
	walkCommands(root, checkCommand, mergeFallback);
	return state;
}

/** Block reason for the command, or null when the command may run. */
export function sleepBlockReason(command: string): string | null {
	const { totalSeconds, hasUnknown } = inspectSleep(command);
	if (hasUnknown) {
		return `Blocked: sleep with unevaluable arguments. ${GUIDANCE}`;
	}
	if (totalSeconds >= MAX_SLEEP_SECONDS) {
		return `Blocked: sleep ${formatSeconds(totalSeconds)} (max ${MAX_SLEEP_SECONDS}s). ${GUIDANCE}`;
	}
	return null;
}

const PROCESS_POLL_GUIDANCE =
	"Do not poll process names. Wait on the pid instead: background_task reports the pid at start and notifies when it completes. Find any other pid with pgrep <name> without -f.";

const BRACKET_RE = /\[[^\]]+\]/;
const PGREP_FALLBACK_RE = /(^|[|&;()`])\s*(pgrep|pkill)\b[^|&;]*?(?:\s--full(?:=|\s|$)|\s-[A-Za-z]*f)/;

function isFullFlag(text: string): boolean {
	if (text === "--full" || text.startsWith("--full=")) return true;
	if (!text.startsWith("-") || text.startsWith("--")) return false;
	return text.slice(1).includes("f");
}

function processName(value: string | undefined): string | null {
	if (!value) return null;
	if (value === "pgrep" || value === "pkill") return value;
	if (value.endsWith("/pgrep")) return "pgrep";
	if (value.endsWith("/pkill")) return "pkill";
	return null;
}

interface ProcessPollInspection {
	matched: boolean;
	name: string;
	sample: string;
}

const NO_PROCESS_POLL: ProcessPollInspection = { matched: false, name: "", sample: "" };

function regexProcessPoll(command: string): ProcessPollInspection {
	const unquoted = command.replace(QUOTED_RE, "");
	const match = PGREP_FALLBACK_RE.exec(unquoted);
	if (!match) return { ...NO_PROCESS_POLL };
	return { matched: true, name: match[2] ?? "pgrep", sample: "" };
}

/**
 * Inspect a shell command for `pgrep -f` / `pkill -f` process-name polls.
 * The watching shell is spawned as `bash -c '<command>'`, so its own argv
 * contains the searched pattern and `-f` (full command line) matching always
 * finds the watcher itself. The `[x]` bracket trick is the only exempt form:
 * the literal brackets in argv do not match the expanded regex.
 */
function inspectProcessPoll(command: string): ProcessPollInspection {
	const state: ProcessPollInspection = { ...NO_PROCESS_POLL };
	let root: ParsedScript;
	try {
		root = parse(command);
	} catch {
		return regexProcessPoll(command);
	}
	let fallbackApplied = false;
	const mergeFallback = (): void => {
		if (fallbackApplied) return;
		fallbackApplied = true;
		const fallback = regexProcessPoll(command);
		if (fallback.matched && !state.matched) {
			state.matched = true;
			state.name = fallback.name;
		}
	};
	const checkCommand = (node: Command): void => {
		if (state.matched) return;
		const name = processName(node.name?.value);
		if (name === null) return;
		let full = false;
		let endOfOptions = false;
		let unsafe: string | null = null;
		let hasOperand = false;
		for (const arg of node.suffix) {
			const text = arg.value;
			if (!endOfOptions && text === "--") {
				endOfOptions = true;
				continue;
			}
			if (!endOfOptions && text.startsWith("-") && text.length > 1) {
				if (isFullFlag(text)) full = true;
				continue;
			}
			hasOperand = true;
			if (unsafe === null && !BRACKET_RE.test(text)) unsafe = text;
		}
		if (full && hasOperand && unsafe !== null) {
			state.matched = true;
			state.name = name;
			state.sample = unsafe.length > 80 ? `${unsafe.slice(0, 80)}...` : unsafe;
		}
	};
	walkCommands(root, checkCommand, mergeFallback);
	return state;
}

/** Block reason when the command polls process names via pgrep/pkill -f, or null when it may run. */
export function processPollBlockReason(command: string): string | null {
	const { matched, name, sample } = inspectProcessPoll(command);
	if (!matched) return null;
	const detail = sample ? `${name} -f "${sample}"` : `${name} -f`;
	return `Blocked: ${detail} matches the watching shell itself and never clears. ${PROCESS_POLL_GUIDANCE}`;
}
