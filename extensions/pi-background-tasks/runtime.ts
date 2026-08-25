import { spawn } from "node:child_process";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { sleepBlockReason } from "./guard.ts";

type TaskStatus = "running" | "completed" | "failed" | "stopped";

export interface TaskSnapshot {
	id: string;
	command: string;
	title: string;
	notify: boolean;
	heartbeatMs: number;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	updatedAt: number;
	lastOutputAt: number | null;
	status: TaskStatus;
	exitCode: number | null;
	outputBytes: number;
	timedOut: boolean;
}

export interface WaitResult {
	task: TaskSnapshot;
	output: string;
}

export interface TaskEvent {
	type: "exit" | "running";
	task: TaskSnapshot;
	output: string;
}

type ManagedTask = {
	info: TaskSnapshot;
	child: ReturnType<typeof spawn>;
	output: string;
	closed: boolean;
	stopRequested: boolean;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	forceTimer: ReturnType<typeof setTimeout> | null;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
	timeoutMs: number | undefined;
	logBytes: number;
	flushOutput: (() => void) | null;
	appendOutput: ((value: string) => void) | null;
	onOutputRaw: ((data: Buffer) => void) | null;
	waiters: Set<(result: WaitResult) => void>;
};

const BUFFER_LIMIT = 120_000;
const READ_LIMIT = 5_000;
const ALERT_LIMIT = 3_000;
const HEARTBEAT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return timeoutMs;
}

export function tail(text: string, limit = READ_LIMIT): string {
	return text.length <= limit ? text : `[...truncated]\n${text.slice(-limit)}`;
}

function snapshot(task: ManagedTask): TaskSnapshot {
	return { ...task.info };
}

export class BackgroundRuntime {
	private readonly tasks = new Map<string, ManagedTask>();
	private counter = 0;
	private shuttingDown = false;
	constructor(
		private readonly emit: (event: TaskEvent) => void,
		private readonly update: () => void,
		private readonly stateChanged: (runningTaskIds: readonly string[]) => void,
	) {}

	activate(): void {
		this.shuttingDown = false;
	}

	list(): TaskSnapshot[] {
		return [...this.tasks.values()].sort((a, b) => b.info.startedAt - a.info.startedAt).map(snapshot);
	}

	runningNotifiedTaskIds(): string[] {
		return [...this.tasks.values()]
			.filter((task) => task.info.notify && task.info.status === "running")
			.map((task) => task.info.id);
	}

	get(id: string | undefined): TaskSnapshot | undefined {
		const task = this.find(id);
		return task ? snapshot(task) : undefined;
	}

	output(id: string | undefined): string | undefined {
		const task = this.find(id);
		if (!task) return undefined;
		return task.output;
	}

	start(
		command: string,
		cwd: string,
		options: {
			notify?: boolean;
			heartbeatMs?: number;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			onOutputRaw?: (data: Buffer) => void;
		} = {},
	): TaskSnapshot {
		const timeoutMs = resolveTimeoutMs(options.timeout);
		const reason = sleepBlockReason(command);
		if (reason !== null) throw new Error(reason);
		const id = `bg-${++this.counter}`;
		const now = Date.now();
		const logFile = join(tmpdir(), `pi-bg-${id}-${now}.log`);
		const { shell, args } = getShellConfig();
		const child = spawn(shell, [...args, command], {
			cwd,
			env: options.env ?? process.env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		writeFileSync(logFile, "", "utf8");
		const task: ManagedTask = {
			info: {
				id,
				command,
				title: command,
				notify: options.notify ?? true,
				heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
				cwd,
				pid: child.pid ?? 0,
				logFile,
				startedAt: now,
				updatedAt: now,
				lastOutputAt: null,
				status: "running",
				exitCode: null,
				outputBytes: 0,
				timedOut: false,
			},
			child,
			output: "",
			closed: false,
			stopRequested: false,
			heartbeatTimer: null,
			forceTimer: null,
			timeoutTimer: null,
			timeoutMs,
			logBytes: 0,
			flushOutput: null,
			appendOutput: null,
			onOutputRaw: options.onOutputRaw ?? null,
			waiters: new Set(),
		};
		this.tasks.set(id, task);

		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const append = (value: string): void => {
			if (!value || task.closed || !this.tasks.has(task.info.id)) return;
			task.info.outputBytes += Buffer.byteLength(value);
			task.output = `${task.output}${value}`.slice(-BUFFER_LIMIT);
			task.info.updatedAt = Date.now();
			task.info.lastOutputAt = task.info.updatedAt;
			try {
				appendFileSync(task.info.logFile, value, "utf8");
				task.logBytes += Buffer.byteLength(value);
				if (task.logBytes > BUFFER_LIMIT * 2) {
					writeFileSync(task.info.logFile, task.output, "utf8");
					task.logBytes = Buffer.byteLength(task.output);
				}
			} catch {}
			if (!this.shuttingDown) this.update();
		};
		task.appendOutput = append;
		task.flushOutput = (): void => {
			append(stdoutDecoder.end());
			append(stderrDecoder.end());
		};
		child.stdout?.on("data", (data: Buffer) => {
			task.onOutputRaw?.(data);
			append(stdoutDecoder.write(data));
		});
		child.stderr?.on("data", (data: Buffer) => {
			task.onOutputRaw?.(data);
			append(stderrDecoder.write(data));
		});
		child.on("error", (error) => {
			append(`\n[spawn error] ${error.message}\n`);
			this.finish(task, 1);
		});
		child.on("close", (code) => this.finish(task, typeof code === "number" ? code : null));
		task.heartbeatTimer = setInterval(() => this.heartbeat(task), task.info.heartbeatMs);
		task.heartbeatTimer.unref?.();
		if (task.info.notify) {
			this.armTimeout(task);
			this.reportState();
		}
		this.update();
		return snapshot(task);
	}

	stop(id: string | undefined): boolean {
		const task = this.find(id);
		if (!task) return false;
		if (task.info.status !== "running") return true;
		task.stopRequested = true;
		task.info.updatedAt = Date.now();
		this.clearTimeoutTimer(task);
		this.kill(task, "SIGTERM");
		this.armForceKill(task);
		this.update();
		return true;
	}

	clear(): number {
		let count = 0;
		for (const [id, task] of this.tasks) {
			if (task.info.status === "running") continue;
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
			if (task.info.status === "running") {
				task.stopRequested = true;
				task.child.once("close", () => this.removeLog(task));
				this.kill(task, "SIGTERM");
				this.kill(task, "SIGKILL");
			}
			this.finish(task, task.info.exitCode);
			this.removeLog(task);
		}
		this.tasks.clear();
	}

	private reportState(): void {
		this.stateChanged(this.runningNotifiedTaskIds());
	}

	private find(id: string | undefined): ManagedTask | undefined {
		if (!id) return undefined;
		return this.tasks.get(id) ?? [...this.tasks.values()].find((item) => String(item.info.pid) === id);
	}

	private removeLog(task: ManagedTask): void {
		try {
			unlinkSync(task.info.logFile);
		} catch {}
	}

	private kill(task: ManagedTask, signal: NodeJS.Signals): void {
		if (!task.info.pid) return this.finish(task, null);
		try {
			process.kill(process.platform === "win32" ? task.info.pid : -task.info.pid, signal);
		} catch {
			try {
				if (!task.child.kill(signal)) this.finish(task, null);
			} catch {
				this.finish(task, null);
			}
		}
	}

	private clearTimeoutTimer(task: ManagedTask): void {
		if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
		task.timeoutTimer = null;
	}

	private armTimeout(task: ManagedTask): void {
		const timeoutMs = task.timeoutMs;
		if (task.timeoutTimer || timeoutMs === undefined || task.closed) return;
		task.timeoutTimer = setTimeout(() => {
			task.timeoutTimer = null;
			if (task.closed) return;
			task.info.timedOut = true;
			task.appendOutput?.(`\n[timed out after ${timeoutMs / 1000}s]\n`);
			this.kill(task, "SIGTERM");
			this.armForceKill(task);
		}, timeoutMs);
		task.timeoutTimer.unref?.();
	}

	private armForceKill(task: ManagedTask): void {
		if (task.forceTimer) clearTimeout(task.forceTimer);
		task.forceTimer = setTimeout(() => {
			task.forceTimer = null;
			if (!task.closed) this.kill(task, "SIGKILL");
		}, 2_000);
		task.forceTimer.unref?.();
	}

	// Tasks run indefinitely; each heartbeat interval reminds the agent that the task is still running.
	private heartbeat(task: ManagedTask): void {
		if (task.closed || this.shuttingDown || !this.tasks.has(task.info.id)) return;
		if (!task.info.notify) return;
		this.emit({ type: "running", task: snapshot(task), output: tail(task.output, ALERT_LIMIT) });
	}

	private finish(task: ManagedTask, code: number | null): void {
		if (task.closed) return;
		task.child.stdout?.removeAllListeners("data");
		task.child.stderr?.removeAllListeners("data");
		task.flushOutput?.();
		task.flushOutput = null;
		task.appendOutput = null;
		task.onOutputRaw = null;
		task.closed = true;
		task.info.exitCode = code;
		task.info.status = task.stopRequested ? "stopped" : code === 0 ? "completed" : "failed";
		task.info.updatedAt = Date.now();
		if (task.heartbeatTimer) clearInterval(task.heartbeatTimer);
		if (task.forceTimer) clearTimeout(task.forceTimer);
		this.clearTimeoutTimer(task);
		task.heartbeatTimer = null;
		task.forceTimer = null;
		const result: WaitResult = { task: snapshot(task), output: task.output };
		for (const waiter of task.waiters) waiter(result);
		task.waiters.clear();
		if (task.info.notify && !this.shuttingDown) {
			this.emit({ type: "exit", task: snapshot(task), output: tail(task.output, ALERT_LIMIT) });
			this.reportState();
		}
		if (!this.shuttingDown) this.update();
	}

	promote(id: string | undefined): boolean {
		const task = this.find(id);
		if (!task || task.info.notify) return false;
		task.info.notify = true;
		this.armTimeout(task);
		if (task.closed && !this.shuttingDown)
			this.emit({ type: "exit", task: snapshot(task), output: tail(task.output, ALERT_LIMIT) });
		if (!this.shuttingDown) this.reportState();
		this.update();
		return true;
	}

	discard(id: string | undefined): boolean {
		const task = this.find(id);
		if (!task || task.info.notify) return false;
		if (!task.closed) {
			task.stopRequested = true;
			this.clearTimeoutTimer(task);
			this.kill(task, "SIGTERM");
			this.armForceKill(task);
		}
		this.tasks.delete(task.info.id);
		this.removeLog(task);
		return true;
	}

	waitForExit(id: string | undefined, ms: number, signal?: AbortSignal): Promise<WaitResult | null> {
		const task = this.find(id);
		if (!task) return Promise.resolve(null);
		if (task.closed) return Promise.resolve({ task: snapshot(task), output: task.output });
		if (signal?.aborted) return Promise.resolve(null);
		return new Promise((resolve) => {
			let settled = false;
			const settle = (value: WaitResult | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				task.waiters.delete(waiter);
				resolve(value);
			};
			const waiter = (result: WaitResult): void => settle(result);
			const onAbort = (): void => settle(null);
			const timer = setTimeout(() => settle(null), ms);
			signal?.addEventListener("abort", onAbort, { once: true });
			task.waiters.add(waiter);
		});
	}
}
