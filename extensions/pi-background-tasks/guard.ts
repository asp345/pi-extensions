import { type Command, parse, type Word } from "unbash";

const MAX_SLEEP_SECONDS = 30;

const DURATION_RE = /^(\d+(?:\.\d+)?)([smhd])?$/;
const SUFFIX_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

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

/** Visit every command in the unbash AST, covering nested substitutions, function bodies, and heredoc bodies. */
function walkCommands(command: string, visit: (node: Command) => void): void {
	const visited = new WeakSet<object>();
	const walk = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		if (visited.has(value)) return;
		visited.add(value);
		const node = value as Record<string, unknown>;
		if (node.type === "Command") visit(value as Command);
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
	walk(parse(command));
}

/**
 * Sum the literal durations of every `sleep` invocation. `sleep -- <seconds>`
 * is a deliberate opt-in form and is never counted. Returns null when a sleep
 * argument cannot be statically evaluated.
 */
function sleepSeconds(command: string): number | null {
	let total = 0;
	let unknown = false;
	walkCommands(command, (node) => {
		if (node.name?.value !== "sleep") return;
		if (node.suffix[0]?.value === "--") return;
		for (const arg of node.suffix) {
			const seconds = literalSeconds(arg.value);
			if (seconds === null) {
				unknown = true;
				return;
			}
			total += seconds;
		}
	});
	return unknown ? null : total;
}

/** Block reason for the command, or null when the command may run. */
export function sleepBlockReason(command: string): string | null {
	const totalSeconds = sleepSeconds(command);
	if (totalSeconds === null) {
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

/**
 * Find the first `pgrep -f` / `pkill -f` process-name poll.
 * The watching shell is spawned as `bash -c '<command>'`, so its own argv
 * contains the searched pattern and `-f` (full command line) matching always
 * finds the watcher itself. The `[x]` bracket trick is the only exempt form:
 * the literal brackets in argv do not match the expanded regex.
 */
function processPoll(command: string): { name: string; sample: string } | null {
	let found: { name: string; sample: string } | null = null;
	walkCommands(command, (node) => {
		if (found) return;
		const name = processName(node.name?.value);
		if (name === null) return;
		let full = false;
		let endOfOptions = false;
		let unsafe: string | null = null;
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
			if (unsafe === null && !BRACKET_RE.test(text)) unsafe = text;
		}
		if (full && unsafe !== null) {
			found = { name, sample: unsafe.length > 80 ? `${unsafe.slice(0, 80)}...` : unsafe };
		}
	});
	return found;
}

/** Block reason when the command polls process names via pgrep/pkill -f, or null when it may run. */
export function processPollBlockReason(command: string): string | null {
	const poll = processPoll(command);
	if (!poll) return null;
	return `Blocked: ${poll.name} -f "${poll.sample}" matches the watching shell itself and never clears. ${PROCESS_POLL_GUIDANCE}`;
}
