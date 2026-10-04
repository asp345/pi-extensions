import { argumentText, walkCommands } from "../shared/shell.ts";

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

function sleepSeconds(command: string): number | null {
	let total = 0;
	let unknown = false;
	walkCommands(command, (node) => {
		if (node.name?.value !== "sleep") return;
		const args = node.args.map(argumentText);
		if (args[0] === "--") return;
		for (const arg of args) {
			const seconds = literalSeconds(arg);
			if (seconds === null) {
				unknown = true;
				return;
			}
			total += seconds;
		}
	});
	return unknown ? null : total;
}

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

function processPoll(command: string): { name: string; sample: string } | null {
	let found: { name: string; sample: string } | null = null;
	walkCommands(command, (node) => {
		if (found) return;
		const name = processName(node.name?.value);
		if (name === null) return;
		let full = false;
		let endOfOptions = false;
		let unsafe: string | null = null;
		for (const text of node.args.map(argumentText)) {
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

export function processPollBlockReason(command: string): string | null {
	const poll = processPoll(command);
	if (!poll) return null;
	return `Blocked: ${poll.name} -f "${poll.sample}" matches the watching shell itself and never clears. ${PROCESS_POLL_GUIDANCE}`;
}
