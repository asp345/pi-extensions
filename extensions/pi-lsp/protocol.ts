import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { commandFor, envName, record, resolveCommand, type ServerConfig } from "./routing.js";

export interface Position {
	line: number;
	character: number;
}
export interface Range {
	start: Position;
	end: Position;
}
export interface Diagnostic {
	range: Range;
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}
export interface TextEdit {
	range: Range;
	newText: string;
}
export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: TextEdit[] }>;
}
interface CodeAction {
	title: string;
	kind?: string;
	edit?: WorkspaceEdit;
	data?: unknown;
}

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_CONTENT_BYTES + MAX_HEADER_BYTES + 4;

interface Message {
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
}

export class LspClient {
	private child?: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<
		number | string,
		{ resolve: (message: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private diagnosticsByUri = new Map<string, Diagnostic[]>();
	private diagnosticWaiters = new Map<string, Set<(items: Diagnostic[]) => void>>();
	private capabilities: Record<string, unknown> = {};
	private stderr = "";

	constructor(
		private readonly server: ServerConfig,
		private readonly root: string,
		private readonly timeoutMs: number,
	) {}

	async start(signal?: AbortSignal) {
		const [rawCommand, ...args] = commandFor(this.server);
		const command = rawCommand && resolveCommand(rawCommand, this.root, this.server.env);
		if (!rawCommand || !command) {
			throw new Error(
				`${this.server.name} LSP command is missing: ${rawCommand ?? "(empty)"}. Install it or set ${envName(this.server.name)}.`,
			);
		}
		if (signal?.aborted) throw new Error(`${this.server.name} LSP request aborted.`);
		const executable =
			process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command) ? (process.env.ComSpec ?? "cmd.exe") : command;
		const executableArgs = executable === command ? args : ["/d", "/s", "/c", command, ...args];
		const child = spawn(executable, executableArgs, {
			cwd: this.root,
			env: { ...process.env, ...this.server.env },
			stdio: "pipe",
		});
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8_000);
		});
		child.once("exit", (code, exitSignal) => {
			if (this.child === child) this.child = undefined;
			this.fail(`server exited (${exitSignal ?? code ?? "unknown"})`);
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		const abort = () => this.close();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await this.initialize();
		} catch (error) {
			signal?.removeEventListener("abort", abort);
			this.close();
			throw error;
		}
	}

	open(uri: string, text: string, languageId: string) {
		this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
	}

	closeDocument(uri: string) {
		if (this.child) this.notify("textDocument/didClose", { textDocument: { uri } });
	}

	async diagnostics(uri: string) {
		if (this.capabilities.diagnosticProvider) {
			const response = await this.request("textDocument/diagnostic", { textDocument: { uri } });
			const items =
				record(response.result) && Array.isArray(response.result.items) ? (response.result.items as Diagnostic[]) : [];
			if (items.length || this.diagnosticsByUri.has(uri)) return items.length ? items : this.diagnosticsByUri.get(uri)!;
		}
		return this.waitForDiagnostics(uri);
	}

	async actions(uri: string, text: string, diagnostics: Diagnostic[], kind: string) {
		const response = await this.request("textDocument/codeAction", {
			textDocument: { uri },
			range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) },
			context: { diagnostics, only: [kind] },
		});
		const actions = Array.isArray(response.result) ? (response.result as CodeAction[]) : [];
		const provider = this.capabilities.codeActionProvider;
		const canResolve = record(provider) && provider.resolveProvider === true;
		if (!canResolve) return actions;
		return Promise.all(
			actions.map(async (action) => {
				if (action.edit) return action;
				const resolved = await this.request("codeAction/resolve", action);
				return record(resolved.result) ? (resolved.result as unknown as CodeAction) : action;
			}),
		);
	}

	async shutdown() {
		if (!this.child) return;
		try {
			await this.request("shutdown", null, 2_000);
			this.notify("exit", undefined);
		} catch {}
		this.close();
	}

	close() {
		this.settle(new Error(`${this.server.name} LSP request cancelled.`));
		this.buffer = Buffer.alloc(0);
		const child = this.child;
		if (child && !child.killed) {
			child.kill("SIGTERM");
			const force = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 2_000);
			force.unref?.();
		}
		this.child = undefined;
	}

	private async initialize() {
		const rootUri = directoryUri(this.root);
		const response = await this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) || "workspace" }],
			initializationOptions: this.server.initialization ?? {},
			capabilities: {
				textDocument: {
					codeAction: { resolveSupport: { properties: ["edit"] } },
					diagnostic: {},
					publishDiagnostics: {},
					synchronization: {},
				},
				workspace: { configuration: true, workspaceEdit: { documentChanges: true }, workspaceFolders: true },
			},
		});
		this.capabilities =
			record(response.result) && record(response.result.capabilities) ? response.result.capabilities : {};
		this.notify("initialized", {});
		if (this.server.initialization)
			this.notify("workspace/didChangeConfiguration", { settings: this.server.initialization });
	}

	private request(method: string, params: unknown, timeoutMs = this.timeoutMs) {
		const id = this.nextId++;
		return new Promise<Message>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.server.name} LSP request timed out: ${method}.${this.stderrText()}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	private notify(method: string, params: unknown) {
		this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
	}

	private send(message: object) {
		if (!this.child) throw new Error(`${this.server.name} LSP server is not running.`);
		const body = JSON.stringify(message);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	private onData(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		try {
			if (this.buffer.length > MAX_BUFFER_BYTES) throw new Error("frame buffer limit exceeded");
			while (true) {
				const split = this.buffer.indexOf("\r\n\r\n");
				if (split < 0) {
					if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("header limit exceeded");
					return;
				}
				if (split > MAX_HEADER_BYTES) throw new Error("header limit exceeded");
				const header = this.buffer.subarray(0, split).toString("utf8");
				const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
				if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid Content-Length header");
				if (length > MAX_CONTENT_BYTES) throw new Error(`Content-Length ${length} exceeds ${MAX_CONTENT_BYTES}`);
				const start = split + 4;
				if (this.buffer.length < start + length) return;
				const message = JSON.parse(this.buffer.subarray(start, start + length).toString("utf8")) as Message;
				this.buffer = this.buffer.subarray(start + length);
				this.handle(message);
			}
		} catch (error) {
			this.fail(`invalid JSON-RPC response: ${error instanceof Error ? error.message : String(error)}`);
			this.close();
		}
	}

	private handle(message: Message) {
		if ((typeof message.id === "number" || typeof message.id === "string") && !message.method) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error)
				pending.reject(new Error(`${this.server.name} LSP error: ${message.error.message ?? "unknown"}`));
			else pending.resolve(message);
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params;
			if (record(params) && typeof params.uri === "string") {
				const items = Array.isArray(params.diagnostics) ? (params.diagnostics as Diagnostic[]) : [];
				this.diagnosticsByUri.set(params.uri, items);
				for (const waiter of this.diagnosticWaiters.get(params.uri) ?? []) waiter(items);
			}
			return;
		}
		if (message.id !== undefined && message.method) this.serverRequest(message);
	}

	private serverRequest(message: Message) {
		let result: unknown;
		if (message.method === "workspace/configuration") {
			const items = record(message.params) && Array.isArray(message.params.items) ? message.params.items : [];
			result = items.map((item) =>
				record(item) && typeof item.section === "string"
					? (this.server.initialization?.[item.section] ?? {})
					: (this.server.initialization ?? {}),
			);
		} else if (message.method === "workspace/workspaceFolders") {
			const uri = directoryUri(this.root);
			result = [{ uri, name: path.basename(this.root) || "workspace" }];
		} else if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
			result = null;
		} else {
			this.send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: `Method not found: ${message.method}` },
			});
			return;
		}
		this.send({ jsonrpc: "2.0", id: message.id, result });
	}

	private waitForDiagnostics(uri: string) {
		const existing = this.diagnosticsByUri.get(uri);
		if (existing) return Promise.resolve(existing);
		return new Promise<Diagnostic[]>((resolve) => {
			let settled = false;
			const finish = (items: Diagnostic[]) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				waiters.delete(finish);
				resolve(items);
			};
			const waiters = this.diagnosticWaiters.get(uri) ?? new Set<(items: Diagnostic[]) => void>();
			waiters.add(finish);
			this.diagnosticWaiters.set(uri, waiters);
			const timer = setTimeout(
				() => finish(this.diagnosticsByUri.get(uri) ?? []),
				Math.min(this.timeoutMs, this.server.diagnosticsGraceMs),
			);
		});
	}

	private fail(reason: string) {
		this.settle(new Error(`${this.server.name} LSP ${reason}.${this.stderrText()}`));
	}

	private settle(error: Error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiters of this.diagnosticWaiters.values()) {
			for (const finish of waiters) finish([]);
		}
		this.diagnosticWaiters.clear();
	}

	private stderrText() {
		return this.stderr.trim() ? ` Server stderr: ${this.stderr.trim()}` : "";
	}
}

function positionAt(text: string, offset: number): Position {
	const prefix = text.slice(0, Math.max(0, Math.min(text.length, offset)));
	const lines = prefix.split("\n");
	return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

export function offsetAt(text: string, position: Position) {
	if (!Number.isInteger(position.line) || !Number.isInteger(position.character)) {
		throw new Error("LSP edit position must use integer line and character values.");
	}
	if (position.line < 0 || position.character < 0) throw new Error("LSP edit position cannot be negative.");
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1);
	if (position.line >= starts.length) throw new Error("LSP edit line is outside the document.");
	const start = starts[position.line]!;
	let end = position.line + 1 < starts.length ? starts[position.line + 1]! - 1 : text.length;
	if (end > start && text[end - 1] === "\r") end -= 1;
	if (position.character > end - start) throw new Error("LSP edit character is outside the line.");
	return start + position.character;
}

export function applyEdits(text: string, edits: TextEdit[]) {
	const positioned = edits.map((edit, index) => {
		const start = offsetAt(text, edit.range.start);
		const end = offsetAt(text, edit.range.end);
		if (start > end) throw new Error("LSP edit range start is after its end.");
		return { edit, index, start, end };
	});
	for (let left = 0; left < positioned.length; left += 1) {
		for (let right = left + 1; right < positioned.length; right += 1) {
			const a = positioned[left]!;
			const b = positioned[right]!;
			if (Math.max(a.start, b.start) < Math.min(a.end, b.end)) throw new Error("LSP returned overlapping text edits.");
		}
	}
	let output = text;
	for (const item of positioned.sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index)) {
		output = `${output.slice(0, item.start)}${item.edit.newText}${output.slice(item.end)}`;
	}
	return output;
}

function directoryUri(root: string) {
	return pathToFileURL(root.endsWith(path.sep) ? root : `${root}${path.sep}`).href;
}
