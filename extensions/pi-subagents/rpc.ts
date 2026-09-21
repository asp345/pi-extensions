import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type RpcMessage = AgentSession["messages"][number];

export const REPORT_TOOL_NAME = "report_to_parent";

export const PARENT_ONLY_TOOLS = [
	"launch_subagent",
	"get_subagent_result",
	"steer_subagent",
	"control_subagent",
	"list_subagents",
	"question",
	"goal_complete",
	"goal_blocked",
];

export interface RpcModelRef {
	provider: string;
	id: string;
}

export interface RpcState {
	sessionFile?: string;
	sessionId?: string;
	model?: RpcModelRef;
}

export interface RpcProcess {
	readonly closed: boolean;
	onEvent(listener: (event: Record<string, unknown>) => void): () => void;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(timeoutMs?: number): Promise<void>;
	getMessages(): Promise<RpcMessage[]>;
	getLastAssistantText(): Promise<string | null>;
	getState(): Promise<RpcState>;
	setModel(provider: string, modelId: string): Promise<RpcModelRef>;
	setThinkingLevel(level: string): Promise<void>;
	setSessionName(name: string): Promise<void>;
	stop(): Promise<void>;
}

interface WireResponse {
	type: string;
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

interface Pending {
	resolve: (response: WireResponse) => void;
	reject: (error: Error) => void;
}

const RESPONSE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;
const STARTUP_GRACE_MS = 500;
const STDERR_LIMIT = 16_000;

export function resolvePiBinary(): string {
	const dir = process.env.PI_PACKAGE_DIR;
	if (dir) {
		const candidate = join(dir, "pi");
		if (existsSync(candidate)) return candidate;
	}
	return "pi";
}

export async function spawnRpcProcess(options: { cwd: string; args: string[] }): Promise<RpcProcess> {
	const child = spawn(resolvePiBinary(), ["--mode", "rpc", ...options.args], {
		cwd: options.cwd,
		env: childEnv(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const proc = new RpcProcessImpl(child);
	await proc.waitForSpawn();
	return proc;
}

function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.PI_SESSION_FILE;
	delete env.PI_SESSION_ID;
	return env;
}

class RpcProcessImpl implements RpcProcess {
	private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
	private readonly exitListeners = new Set<(error: Error) => void>();
	private readonly pending = new Map<string, Pending>();
	private requestId = 0;
	private stderr = "";
	private exitErrorValue?: Error;
	private stopped = false;

	constructor(private readonly child: ChildProcess) {
		this.child.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (this.stderr.length > STDERR_LIMIT) this.stderr = this.stderr.slice(-STDERR_LIMIT);
		});
		this.child.once("error", (error) => {
			this.fail(new Error(`Subagent process failed to start: ${error.message}`));
		});
		this.child.once("exit", (code, signal) => {
			this.fail(
				new Error(
					`Subagent process exited (code=${code ?? "unknown"} signal=${signal ?? "none"}). Stderr: ${this.stderr.trim() || "empty"}`,
				),
			);
		});
		this.attachReader();
	}

	get closed(): boolean {
		return this.child.exitCode !== null || this.exitErrorValue !== undefined;
	}

	async waitForSpawn(): Promise<void> {
		const error = await new Promise<Error | undefined>((resolve) => {
			let done = false;
			const finish = (value?: Error) => {
				if (done) return;
				done = true;
				resolve(value);
			};
			this.child.once("error", (cause) =>
				finish(new Error(`Subagent process failed to start: ${(cause as Error).message}`)),
			);
			const timer = setTimeout(() => finish(undefined), STARTUP_GRACE_MS);
			timer.unref?.();
		});
		if (error) throw error;
		if (this.child.exitCode !== null) throw this.describeExit();
	}

	onEvent(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async prompt(message: string): Promise<void> {
		await this.sendChecked({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.sendChecked({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.sendChecked({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		if (this.closed) return;
		await this.sendChecked({ type: "abort" });
	}

	waitForIdle(timeoutMs?: number): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.exitErrorValue) {
				reject(this.exitErrorValue);
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				off();
				this.exitListeners.delete(onExit);
			};
			const off = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					cleanup();
					resolve();
				}
			});
			const onExit = (error: Error) => {
				cleanup();
				reject(error);
			};
			this.exitListeners.add(onExit);
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					cleanup();
					reject(new Error("Timed out waiting for the subagent to settle."));
				}, timeoutMs);
				timer.unref?.();
			}
		});
	}

	async getMessages(): Promise<RpcMessage[]> {
		const data = (await this.sendChecked({ type: "get_messages" })) as { messages?: RpcMessage[] };
		return data.messages ?? [];
	}

	async getLastAssistantText(): Promise<string | null> {
		const data = (await this.sendChecked({ type: "get_last_assistant_text" })) as { text?: string | null };
		return data.text ?? null;
	}

	async getState(): Promise<RpcState> {
		const data = (await this.sendChecked({ type: "get_state" })) as {
			sessionFile?: unknown;
			sessionId?: unknown;
			model?: unknown;
		};
		const state: RpcState = {};
		if (typeof data.sessionFile === "string") state.sessionFile = data.sessionFile;
		if (typeof data.sessionId === "string") state.sessionId = data.sessionId;
		if (isRecord(data.model)) {
			const provider = data.model.provider;
			const id = data.model.id;
			if (typeof provider === "string" && typeof id === "string") state.model = { provider, id };
		}
		return state;
	}

	async setModel(provider: string, modelId: string): Promise<RpcModelRef> {
		const data = (await this.sendChecked({ type: "set_model", provider, modelId })) as {
			provider?: unknown;
			id?: unknown;
		};
		if (typeof data.provider !== "string" || typeof data.id !== "string") {
			throw new Error(`Subagent model was not applied: ${provider}/${modelId}`);
		}
		return { provider: data.provider, id: data.id };
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.sendChecked({ type: "set_thinking_level", level });
	}

	async setSessionName(name: string): Promise<void> {
		await this.sendChecked({ type: "set_session_name", name });
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		const error = new Error("Subagent process stopped.");
		for (const [, pending] of this.pending) pending.reject(error);
		this.pending.clear();
		this.listeners.clear();
		if (!this.child.killed && this.child.exitCode === null) {
			this.child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				if (this.child.exitCode !== null) {
					resolve();
					return;
				}
				const timer = setTimeout(() => {
					try {
						this.child.kill("SIGKILL");
					} catch {}
					resolve();
				}, STOP_TIMEOUT_MS);
				timer.unref?.();
				this.child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	private fail(error: Error): void {
		if (this.exitErrorValue) return;
		this.exitErrorValue = error;
		for (const [, pending] of this.pending) pending.reject(error);
		this.pending.clear();
		for (const listener of [...this.exitListeners]) listener(error);
		this.exitListeners.clear();
	}

	private describeExit(): Error {
		return new Error(
			`Subagent process exited during startup (code=${this.child.exitCode ?? "unknown"}). Stderr: ${this.stderr.trim() || "empty"}`,
		);
	}

	private send(command: Record<string, unknown>): Promise<WireResponse> {
		if (this.exitErrorValue) return Promise.reject(this.exitErrorValue);
		if (this.child.exitCode !== null) {
			const error = this.describeExit();
			this.fail(error);
			return Promise.reject(error);
		}
		const stdin = this.child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			const error = new Error("Subagent process stdin is not writable.");
			this.fail(error);
			return Promise.reject(error);
		}
		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for subagent response to ${String(command.type)}.`));
			}, RESPONSE_TIMEOUT_MS);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private async sendChecked(command: Record<string, unknown>): Promise<unknown> {
		const response = await this.send(command);
		if (!response.success) throw new Error(response.error || `Subagent command ${String(command.type)} failed.`);
		return response.data;
	}

	private attachReader(): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.child.stdout?.on("data", (chunk: Buffer | string) => {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				this.handleLine(buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
		});
	}

	private handleLine(line: string): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (data.type === "response" && typeof data.id === "string") {
			const pending = this.pending.get(data.id);
			if (pending) {
				this.pending.delete(data.id);
				pending.resolve(data as unknown as WireResponse);
			}
			return;
		}
		if (data.type === "extension_ui_request" && typeof data.id === "string") {
			this.answerExtensionUi(data.id, data.method);
			return;
		}
		for (const listener of [...this.listeners]) {
			try {
				listener(data);
			} catch {}
		}
	}

	private answerExtensionUi(id: string, method: unknown): void {
		if (
			method === "notify" ||
			method === "setStatus" ||
			method === "setWidget" ||
			method === "setTitle" ||
			method === "set_editor_text"
		) {
			return;
		}
		try {
			this.child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
		} catch {}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
