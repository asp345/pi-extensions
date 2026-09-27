export type CdpParams = Record<string, unknown>;
type Listener = (method: string, params: CdpParams, sessionId?: string) => void;

interface Pending {
	method: string;
	resolve: (value: CdpParams) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Message {
	id?: number;
	method?: string;
	params?: CdpParams;
	result?: CdpParams;
	error?: { message: string };
	sessionId?: string;
}

const TIMEOUT_MS = 30_000;

export class Cdp {
	readonly #ws: WebSocket;
	#id = 0;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<Listener>();
	readonly #closeListeners = new Set<() => void>();

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = (event) => this.#receive(JSON.parse(String(event.data)) as Message);
		ws.onclose = () => {
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`CDP connection closed during ${pending.method}`));
			}
			this.#pending.clear();
			for (const listener of this.#closeListeners) listener();
		};
	}

	static connect(url: string): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.onopen = () => resolve(new Cdp(ws));
			ws.onerror = () => reject(new Error(`Cannot connect to ${url}`));
		});
	}

	send<T = CdpParams>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
		const id = ++this.#id;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`CDP ${method} timed out after ${TIMEOUT_MS / 1000}s`));
			}, TIMEOUT_MS);
			this.#pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
			this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		});
	}

	onEvent(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onClose(listener: () => void): void {
		this.#closeListeners.add(listener);
	}

	waitFor(
		label: string,
		match: (method: string, params: CdpParams, sessionId?: string) => boolean,
		timeoutMs: number,
	): { promise: Promise<void>; cancel: () => void } {
		let off = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			clearTimeout(timer);
			off();
		};
		const promise = new Promise<void>((resolve, reject) => {
			off = this.onEvent((method, params, sessionId) => {
				if (!match(method, params, sessionId)) return;
				cancel();
				resolve();
			});
			timer = setTimeout(() => {
				off();
				reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${label}`));
			}, timeoutMs);
		});
		return { promise, cancel };
	}

	close(): void {
		this.#ws.close();
	}

	#receive(message: Message): void {
		if (message.id !== undefined) {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
			else pending.resolve(message.result ?? {});
			return;
		}
		if (!message.method) return;
		for (const listener of this.#listeners) listener(message.method, message.params ?? {}, message.sessionId);
	}
}
