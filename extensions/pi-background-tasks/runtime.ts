import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export type TaskStatus = "running" | "completed" | "failed" | "stopped";

export interface TaskSnapshot {
	id: string;
	command: string;
	title: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	updatedAt: number;
	lastOutputAt: number | null;
	expiresAt: number;
	status: TaskStatus;
	exitCode: number | null;
	outputBytes: number;
}

export interface TaskEvent {
	type: "output" | "exit";
	task: TaskSnapshot;
	output: string;
}

type ManagedTask = TaskSnapshot & {
	child: ReturnType<typeof spawn>;
	output: string;
	closed: boolean;
	stopRequested: boolean;
	notifyTimer: ReturnType<typeof setTimeout> | null;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	forceTimer: ReturnType<typeof setTimeout> | null;
	logBytes: number;
	pendingNotify: string;
	notifyDeadline: number;
	flushOutput: (() => void) | null;
};

export interface RuntimeOptions {
	notifyDebounceMs?: number;
	notifyMaxWaitMs?: number;
}

const BUFFER_LIMIT = 120_000;
export const READ_LIMIT = 5_000;
const ALERT_LIMIT = 3_000;
const TIMEOUT_MS = 10 * 60_000;
const NOTIFY_DEBOUNCE_MS = 1500;
const NOTIFY_MAX_WAIT_MS = 5000;

export function tail(text: string, limit = READ_LIMIT): string {
	return text.length <= limit ? text : `[...truncated]\n${text.slice(-limit)}`;
}

function snapshot(task: ManagedTask): TaskSnapshot {
	const {
		child: _child,
		output: _output,
		closed: _closed,
		stopRequested: _stop,
		notifyTimer: _notify,
		expiryTimer: _expiry,
		forceTimer: _force,
		logBytes: _logBytes,
		pendingNotify: _pendingNotify,
		notifyDeadline: _notifyDeadline,
		flushOutput: _flushOutput,
		...value
	} = task;
	return value;
}

export class BackgroundRuntime {
	private readonly tasks = new Map<string, ManagedTask>();
	private counter = 0;
	private shuttingDown = false;
	private readonly notifyDebounceMs: number;
	private readonly notifyMaxWaitMs: number;
	constructor(
		private readonly emit: (event: TaskEvent) => void,
		private readonly update: () => void,
		options: RuntimeOptions = {},
	) {
		this.notifyDebounceMs = options.notifyDebounceMs ?? NOTIFY_DEBOUNCE_MS;
		this.notifyMaxWaitMs = options.notifyMaxWaitMs ?? NOTIFY_MAX_WAIT_MS;
	}

	activate(): void {
		this.shuttingDown = false;
	}

	list(): TaskSnapshot[] {
		return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map(snapshot);
	}

	get(id: string | undefined): TaskSnapshot | undefined {
		if (!id) return undefined;
		const task = this.tasks.get(id) ?? [...this.tasks.values()].find((item) => String(item.pid) === id);
		return task ? snapshot(task) : undefined;
	}

	output(id: string | undefined): string | undefined {
		const task = id
			? (this.tasks.get(id) ?? [...this.tasks.values()].find((item) => String(item.pid) === id))
			: undefined;
		if (!task) return undefined;
		if (task.output) return task.output;
		try {
			return existsSync(task.logFile) ? readFileSync(task.logFile, "utf8") : "";
		} catch {
			return "";
		}
	}

	start(command: string, cwd: string): TaskSnapshot {
		const id = `bg-${++this.counter}`;
		const now = Date.now();
		const logFile = join(tmpdir(), `pi-bg-${id}-${now}.log`);
		const { shell, args } = getShellConfig();
		const child = spawn(shell, [...args, command], {
			cwd,
			env: process.env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		writeFileSync(logFile, "", "utf8");
		const task: ManagedTask = {
			id,
			command,
			title: command,
			cwd,
			pid: child.pid ?? 0,
			logFile,
			startedAt: now,
			updatedAt: now,
			lastOutputAt: null,
			expiresAt: now + TIMEOUT_MS,
			status: "running",
			exitCode: null,
			outputBytes: 0,
			child,
			output: "",
			closed: false,
			stopRequested: false,
			notifyTimer: null,
			expiryTimer: null,
			forceTimer: null,
			logBytes: 0,
			pendingNotify: "",
			notifyDeadline: 0,
			flushOutput: null,
		};
		this.tasks.set(id, task);

		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const append = (value: string): void => {
			if (!value || task.closed || !this.tasks.has(task.id)) return;
			task.outputBytes += Buffer.byteLength(value);
			task.output = `${task.output}${value}`.slice(-BUFFER_LIMIT);
			task.updatedAt = Date.now();
			task.lastOutputAt = task.updatedAt;
			try {
				appendFileSync(task.logFile, value, "utf8");
				task.logBytes += Buffer.byteLength(value);
				if (task.logBytes > BUFFER_LIMIT * 2) {
					writeFileSync(task.logFile, task.output, "utf8");
					task.logBytes = Buffer.byteLength(task.output);
				}
			} catch {}
			task.pendingNotify = `${task.pendingNotify}${value}`.slice(-ALERT_LIMIT);
			if (!this.shuttingDown) {
				this.scheduleNotify(task);
				this.update();
			}
		};
		task.flushOutput = (): void => {
			append(stdoutDecoder.end());
			append(stderrDecoder.end());
		};
		child.stdout?.on("data", (data: Buffer) => append(stdoutDecoder.write(data)));
		child.stderr?.on("data", (data: Buffer) => append(stderrDecoder.write(data)));
		child.on("error", (error) => {
			append(`\n[spawn error] ${error.message}\n`);
			this.finish(task, 1);
		});
		child.on("close", (code) => this.finish(task, typeof code === "number" ? code : null));
		task.expiryTimer = setTimeout(() => this.stop(id), TIMEOUT_MS);
		task.expiryTimer.unref?.();
		this.update();
		return snapshot(task);
	}

	stop(id: string | undefined): boolean {
		const task = id
			? (this.tasks.get(id) ?? [...this.tasks.values()].find((item) => String(item.pid) === id))
			: undefined;
		if (!task) return false;
		if (task.status !== "running") return true;
		task.stopRequested = true;
		task.updatedAt = Date.now();
		this.kill(task, "SIGTERM");
		if (task.forceTimer) clearTimeout(task.forceTimer);
		task.forceTimer = setTimeout(() => {
			task.forceTimer = null;
			if (!task.closed) this.kill(task, "SIGKILL");
		}, 2000);
		task.forceTimer.unref?.();
		this.update();
		return true;
	}

	clear(): number {
		let count = 0;
		for (const [id, task] of this.tasks) {
			if (task.status === "running") continue;
			this.tasks.delete(id);
			this.removeLog(task);
			count++;
		}
		this.update();
		return count;
	}

	shutdown(): void {
		this.shuttingDown = true;
		for (const task of [...this.tasks.values()]) {
			if (task.status === "running") {
				task.stopRequested = true;
				task.child.once("close", () => this.removeLog(task));
				this.kill(task, "SIGTERM");
				this.kill(task, "SIGKILL");
			}
			this.finish(task, task.exitCode);
			this.removeLog(task);
		}
		this.tasks.clear();
	}

	private removeLog(task: ManagedTask): void {
		try {
			unlinkSync(task.logFile);
		} catch {}
	}

	private scheduleNotify(task: ManagedTask): void {
		const now = Date.now();
		if (task.notifyTimer) clearTimeout(task.notifyTimer);
		else task.notifyDeadline = now + this.notifyMaxWaitMs;
		const wait = Math.min(this.notifyDebounceMs, Math.max(0, task.notifyDeadline - now));
		task.notifyTimer = setTimeout(() => {
			task.notifyTimer = null;
			const output = task.pendingNotify;
			task.pendingNotify = "";
			if (task.status === "running" && output) this.emit({ type: "output", task: snapshot(task), output });
		}, wait);
		task.notifyTimer.unref?.();
	}

	private kill(task: ManagedTask, signal: NodeJS.Signals): void {
		if (!task.pid) return this.finish(task, null);
		try {
			process.kill(process.platform === "win32" ? task.pid : -task.pid, signal);
		} catch {
			try {
				if (!task.child.kill(signal)) this.finish(task, null);
			} catch {
				this.finish(task, null);
			}
		}
	}

	private finish(task: ManagedTask, code: number | null): void {
		if (task.closed) return;
		task.child.stdout?.removeAllListeners("data");
		task.child.stderr?.removeAllListeners("data");
		task.flushOutput?.();
		task.flushOutput = null;
		task.closed = true;
		task.exitCode = code;
		task.status = task.stopRequested ? "stopped" : code === 0 ? "completed" : "failed";
		task.updatedAt = Date.now();
		task.pendingNotify = "";
		if (task.notifyTimer) clearTimeout(task.notifyTimer);
		if (task.expiryTimer) clearTimeout(task.expiryTimer);
		if (task.forceTimer) clearTimeout(task.forceTimer);
		task.notifyTimer = null;
		task.expiryTimer = null;
		task.forceTimer = null;
		if (this.shuttingDown) return;
		this.emit({ type: "exit", task: snapshot(task), output: tail(task.output, ALERT_LIMIT) });
		this.update();
	}
}
