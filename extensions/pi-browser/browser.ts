import { spawn } from "node:child_process";
import { link, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Cdp, type CdpParams } from "./cdp.ts";
import { type AxNode, formatAxTree } from "./snapshot.ts";

export const PROFILE_DIR = join(getAgentDir(), "helium");
const PORT_FILE = join(PROFILE_DIR, "DevToolsActivePort");
const LAUNCH_TIMEOUT_MS = 20_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DOWNLOAD_DIR = join(homedir(), "Downloads", "agent");
const BUFFER_LIMIT = 500;
const TAB_DOMAINS = ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"];

export interface ConsoleEntry {
	level: string;
	text: string;
	source?: string;
}

export interface NetworkEntry {
	id: string;
	method: string;
	url: string;
	type?: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	postData?: string;
	size?: number;
	error?: string;
}

export interface Tab {
	targetId: string;
	sessionId: string;
	console: ConsoleEntry[];
	network: Map<string, NetworkEntry>;
}

export interface Download {
	path: string;
	bytes: number;
}

interface HeaderEntry {
	name: string;
	value: string;
}

interface PausedResponse {
	requestId: string;
	frameId: string;
	responseStatusCode?: number;
	responseHeaders?: HeaderEntry[];
}

export interface PageInfo {
	targetId: string;
	type: string;
	title: string;
	url: string;
}

interface ObjectPreview {
	subtype?: string;
	overflow: boolean;
	properties: { name: string; type: string; value?: string }[];
}

interface RemoteObject {
	type: string;
	value?: unknown;
	unserializableValue?: string;
	description?: string;
	preview?: ObjectPreview;
}

interface Evaluation {
	result: RemoteObject;
	exceptionDetails?: { text: string; exception?: RemoteObject };
}

interface Cookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	session: boolean;
	sameSite?: string;
}

const KEYS: Record<string, { code: number; text?: string }> = {
	Enter: { code: 13, text: "\r" },
	Tab: { code: 9 },
	Escape: { code: 27 },
	Backspace: { code: 8 },
	Delete: { code: 46 },
	ArrowUp: { code: 38 },
	ArrowDown: { code: 40 },
	ArrowLeft: { code: 37 },
	ArrowRight: { code: 39 },
	PageUp: { code: 33 },
	PageDown: { code: 34 },
	Home: { code: 36 },
	End: { code: 35 },
};

export const KEY_NAMES = Object.keys(KEYS);

function push<T>(list: T[], item: T): void {
	list.push(item);
	if (list.length > BUFFER_LIMIT) list.shift();
}

function previewText({ subtype, overflow, properties }: ObjectPreview): string {
	const values = properties.map((property) =>
		property.type === "string" ? JSON.stringify(property.value) : property.value,
	);
	const items =
		subtype === "array" ? values : properties.map((property, index) => `${property.name}: ${values[index]}`);
	if (overflow) items.push("…");
	return subtype === "array" ? `[${items.join(", ")}]` : `{${items.join(", ")}}`;
}

function remoteText(object: RemoteObject): string {
	if (object.value !== undefined) return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
	if (object.preview && (object.preview.subtype === undefined || object.preview.subtype === "array"))
		return previewText(object.preview);
	return object.unserializableValue ?? object.description ?? object.type;
}

function attachment(headers: HeaderEntry[]): HeaderEntry[] {
	const disposition = headers.find((header) => header.name.toLowerCase() === "content-disposition");
	const value = disposition ? disposition.value.replace(/^[^;]*/, "attachment") : "attachment";
	return [...headers.filter((header) => header !== disposition), { name: "Content-Disposition", value }];
}

async function claim(file: string, name: string): Promise<string> {
	const { name: stem, ext } = parse(name);
	for (let n = 0; ; n++) {
		const target = join(DOWNLOAD_DIR, n === 0 ? name : `${stem} (${n})${ext}`);
		const linked = await link(file, target).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "EEXIST") return false;
				throw error;
			},
		);
		if (!linked) continue;
		await rm(file);
		return target;
	}
}

function location(url: unknown, line: unknown): string | undefined {
	if (typeof url !== "string" || !url) return undefined;
	return typeof line === "number" ? `${url}:${line + 1}` : url;
}

async function attach(): Promise<Cdp | undefined> {
	const text = await readFile(PORT_FILE, "utf8").catch(() => undefined);
	const [port, path] = text?.trim().split("\n") ?? [];
	if (!port || !path) return undefined;
	return Cdp.connect(`ws://127.0.0.1:${port}${path}`).catch(() => undefined);
}

async function launch(headed: boolean): Promise<Cdp> {
	await rm(PORT_FILE, { force: true });
	const args = [
		`--user-data-dir=${PROFILE_DIR}`,
		"--remote-debugging-port=0",
		"--disable-blink-features=AutomationControlled",
		"--no-first-run",
		"--no-default-browser-check",
	];
	const child = spawn("helium", headed ? args : [...args, "--headless"], { detached: true, stdio: "ignore" });
	const failed = new Promise<never>((_resolve, reject) => child.once("error", reject));
	child.unref();
	const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const cdp = await Promise.race([attach(), failed]);
		if (cdp) return cdp;
		await Promise.race([sleep(200), failed]);
	}
	throw new Error(
		`Helium did not open a DevTools port within ${LAUNCH_TIMEOUT_MS / 1000}s. If Helium is already running with ${PROFILE_DIR} without remote debugging, close that window first.`,
	);
}

export class Browser {
	#cdp?: Cdp;
	#connecting?: Promise<Cdp>;
	readonly #tabs = new Map<string, Tab>();
	readonly #sessions = new Map<string, Tab>();
	#current?: string;
	#headed = true;
	timeoutMs = DEFAULT_TIMEOUT_MS;

	get connected(): boolean {
		return this.#cdp !== undefined;
	}

	connection(): Promise<Cdp> {
		if (this.#cdp) return Promise.resolve(this.#cdp);
		this.#connecting ??= this.#connect().finally(() => {
			this.#connecting = undefined;
		});
		return this.#connecting;
	}

	close(): void {
		const cdp = this.#cdp;
		this.#reset(cdp);
		cdp?.close();
	}

	async launch(headed: boolean): Promise<void> {
		this.#headed = headed;
		if ((await this.headless()) !== headed) return;
		await this.quit();
		await this.connection();
	}

	async headless(): Promise<boolean> {
		const cdp = await this.connection();
		const { userAgent } = await cdp.send<{ userAgent: string }>(this.timeoutMs, "Browser.getVersion");
		return userAgent.includes("HeadlessChrome");
	}

	async quit(): Promise<boolean> {
		const cdp = this.#cdp ?? (await attach());
		if (!cdp) return false;
		const closed = new Promise<void>((resolve) => cdp.onClose(resolve));
		await cdp.send(this.timeoutMs, "Browser.close");
		await closed;
		return true;
	}

	async pages(): Promise<PageInfo[]> {
		const cdp = await this.connection();
		const { targetInfos } = await cdp.send<{ targetInfos: PageInfo[] }>(this.timeoutMs, "Target.getTargets");
		return targetInfos.filter((target) => target.type === "page");
	}

	isCurrent(targetId: string): boolean {
		return targetId === this.#current;
	}

	async tab(prefix?: string): Promise<Tab> {
		const ids = (await this.pages()).map((page) => page.targetId);
		if (prefix) return this.#attach(resolvePrefix(prefix, ids));
		return this.#attach(this.#current && ids.includes(this.#current) ? this.#current : await this.#create());
	}

	async open(url?: string): Promise<Tab> {
		const tab = await this.#attach(await this.#create());
		if (url) await this.navigate(tab, url);
		return tab;
	}

	async closeTab(tab: Tab): Promise<void> {
		const cdp = await this.connection();
		const detached = cdp.waitFor(
			"Target.detachedFromTarget",
			(method, params) => method === "Target.detachedFromTarget" && params.sessionId === tab.sessionId,
			this.timeoutMs,
		);
		await cdp.send(this.timeoutMs, "Target.closeTarget", { targetId: tab.targetId }).catch((error: unknown) => {
			detached.cancel();
			throw error;
		});
		await detached.promise;
		if (this.#current === tab.targetId) this.#current = undefined;
	}

	async info(tab: Tab): Promise<PageInfo> {
		const cdp = await this.connection();
		const { targetInfo } = await cdp.send<{ targetInfo: PageInfo }>(this.timeoutMs, "Target.getTargetInfo", {
			targetId: tab.targetId,
		});
		return targetInfo;
	}

	async send<T = CdpParams>(tab: Tab, method: string, params: CdpParams = {}): Promise<T> {
		const cdp = await this.connection();
		return cdp.send<T>(this.timeoutMs, method, params, tab.sessionId);
	}

	async navigate(tab: Tab, url: string): Promise<void> {
		const cdp = await this.connection();
		const loaded = cdp.waitFor(
			"Page.loadEventFired",
			(method, _params, sessionId) => method === "Page.loadEventFired" && sessionId === tab.sessionId,
			this.timeoutMs,
		);
		const result = await cdp
			.send<{ errorText?: string; loaderId?: string }>(this.timeoutMs, "Page.navigate", { url }, tab.sessionId)
			.catch((error: unknown) => {
				loaded.cancel();
				throw error;
			});
		if (result.errorText || !result.loaderId) loaded.cancel();
		if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
		if (result.loaderId) await loaded.promise;
	}

	async download(tab: Tab, url: string, onBlocked: (status: number | undefined) => void): Promise<Download> {
		const cdp = await this.connection();
		await mkdir(DOWNLOAD_DIR, { recursive: true });
		await cdp.send(this.timeoutMs, "Browser.setDownloadBehavior", {
			behavior: "allowAndName",
			downloadPath: DOWNLOAD_DIR,
			eventsEnabled: true,
		});
		let status: number | undefined;
		const continued: Promise<unknown>[] = [];
		const off = cdp.onEvent((method, params, sessionId) => {
			if (method !== "Fetch.requestPaused" || sessionId !== tab.sessionId) return;
			const paused = params as unknown as PausedResponse;
			const mainFrame = paused.frameId === tab.targetId;
			if (mainFrame) status = paused.responseStatusCode;
			const override =
				mainFrame && status !== undefined && status >= 200 && status < 300
					? { responseCode: status, responseHeaders: attachment(paused.responseHeaders ?? []) }
					: {};
			continued.push(
				cdp.send(this.timeoutMs, "Fetch.continueResponse", { requestId: paused.requestId, ...override }, sessionId),
			);
		});
		const began = cdp.waitFor(
			"Browser.downloadWillBegin",
			(method, params) => method === "Browser.downloadWillBegin" && params.frameId === tab.targetId,
			this.timeoutMs,
		);
		try {
			await this.send(tab, "Fetch.enable", {
				patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }],
			});
			const result = await this.send<{ errorText?: string; isDownload: boolean }>(tab, "Page.navigate", { url });
			if (!result.isDownload && result.errorText) throw new Error(`Download of ${url} failed: ${result.errorText}`);
			if (!result.isDownload) onBlocked(status);
			const { guid, suggestedFilename } = (await began.promise.catch(() => {
				throw new Error(`${url} did not start a download within ${this.timeoutMs / 1000}s (HTTP ${status})`);
			})) as { guid: string; suggestedFilename: string };
			const finished = cdp.waitFor(
				"Browser.downloadProgress",
				(method, params) =>
					method === "Browser.downloadProgress" && params.guid === guid && params.state !== "inProgress",
				this.timeoutMs,
			);
			const progress = (await finished.promise.catch(async (error: unknown) => {
				await cdp.send(this.timeoutMs, "Browser.cancelDownload", { guid });
				throw error;
			})) as { state: string; receivedBytes: number; filePath?: string };
			if (progress.state === "canceled") throw new Error(`Download of ${url} was canceled`);
			if (!progress.filePath) throw new Error(`Browser did not report the saved path of ${url}`);
			return { path: await claim(progress.filePath, suggestedFilename), bytes: progress.receivedBytes };
		} finally {
			began.cancel();
			off();
			await this.send(tab, "Fetch.disable");
			await Promise.all(continued);
		}
	}

	async evaluate(tab: Tab, expression: string): Promise<unknown> {
		const { result, exceptionDetails } = await this.send<Evaluation>(tab, "Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
		return result.value;
	}

	async snapshot(tab: Tab): Promise<string> {
		const { nodes } = await this.send<{ nodes: AxNode[] }>(tab, "Accessibility.getFullAXTree");
		return formatAxTree(nodes);
	}

	async click(tab: Tab, point: { x: number; y: number }): Promise<void> {
		const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
		await this.send(tab, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
		await this.send(tab, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
		await this.send(tab, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
	}

	async locate(tab: Tab, selector: string): Promise<{ x: number; y: number; label: string }> {
		const found = (await this.evaluate(
			tab,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return null;
				el.scrollIntoView({ block: "center", inline: "center" });
				const r = el.getBoundingClientRect();
				const text = (el.innerText ?? el.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 80);
				const tag = "<" + el.tagName.toLowerCase() + ">";
				return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: text ? tag + " " + text : tag };
			})()`,
		)) as { x: number; y: number; label: string } | null;
		if (!found) throw new Error(`No element matches ${selector}`);
		return found;
	}

	async key(tab: Tab, name: string): Promise<void> {
		const key = KEYS[name];
		if (!key) throw new Error(`Unsupported key ${name}. Supported: ${KEY_NAMES.join(", ")}`);
		const event = { key: name, code: name, windowsVirtualKeyCode: key.code, text: key.text };
		await this.send(tab, "Input.dispatchKeyEvent", { ...event, type: "keyDown" });
		await this.send(tab, "Input.dispatchKeyEvent", { ...event, type: "keyUp" });
	}

	async cookies(tab: Tab, url?: string): Promise<string> {
		const { cookies } = await this.send<{ cookies: Cookie[] }>(tab, "Network.getCookies", url ? { urls: [url] } : {});
		return cookies
			.map((cookie) => {
				const flags = [
					`${cookie.domain}${cookie.path}`,
					cookie.httpOnly && "HttpOnly",
					cookie.secure && "Secure",
					cookie.sameSite && `SameSite=${cookie.sameSite}`,
					cookie.session ? "session" : `expires=${new Date(cookie.expires * 1000).toISOString()}`,
				].filter(Boolean);
				return `${cookie.name}=${cookie.value}  ${flags.join(" ")}`;
			})
			.join("\n");
	}

	async #connect(): Promise<Cdp> {
		const cdp = (await attach()) ?? (await launch(this.#headed));
		cdp.onEvent((method, params, sessionId) => this.#handle(method, params, sessionId));
		cdp.onClose(() => this.#reset(cdp));
		this.#cdp = cdp;
		return cdp;
	}

	#reset(cdp: Cdp | undefined): void {
		if (!cdp || this.#cdp !== cdp) return;
		this.#cdp = undefined;
		this.#tabs.clear();
		this.#sessions.clear();
		this.#current = undefined;
	}

	async #create(): Promise<string> {
		const cdp = await this.connection();
		const { targetId } = await cdp.send<{ targetId: string }>(this.timeoutMs, "Target.createTarget", {
			url: "about:blank",
		});
		return targetId;
	}

	async #attach(targetId: string): Promise<Tab> {
		this.#current = targetId;
		const existing = this.#tabs.get(targetId);
		if (existing) return existing;
		const cdp = await this.connection();
		const { sessionId } = await cdp.send<{ sessionId: string }>(this.timeoutMs, "Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		const tab: Tab = { targetId, sessionId, console: [], network: new Map() };
		this.#tabs.set(targetId, tab);
		this.#sessions.set(sessionId, tab);
		await Promise.all(TAB_DOMAINS.map((method) => cdp.send(this.timeoutMs, method, {}, sessionId)));
		return tab;
	}

	#handle(method: string, params: CdpParams, sessionId?: string): void {
		if (method === "Target.detachedFromTarget") {
			const tab = this.#sessions.get(String(params.sessionId));
			if (!tab) return;
			this.#sessions.delete(tab.sessionId);
			this.#tabs.delete(tab.targetId);
			return;
		}
		const tab = sessionId ? this.#sessions.get(sessionId) : undefined;
		if (!tab) return;
		switch (method) {
			case "Runtime.consoleAPICalled": {
				const args = params.args as RemoteObject[];
				push(tab.console, { level: String(params.type), text: args.map(remoteText).join(" ") });
				return;
			}
			case "Runtime.exceptionThrown": {
				const details = params.exceptionDetails as {
					text: string;
					exception?: RemoteObject;
					url?: string;
					lineNumber?: number;
				};
				push(tab.console, {
					level: "exception",
					text: details.exception?.description ?? details.text,
					source: location(details.url, details.lineNumber),
				});
				return;
			}
			case "Log.entryAdded": {
				const entry = params.entry as { level: string; text: string; url?: string; lineNumber?: number };
				if (entry.level === "verbose") return;
				push(tab.console, { level: entry.level, text: entry.text, source: location(entry.url, entry.lineNumber) });
				return;
			}
			case "Network.requestWillBeSent": {
				const request = params.request as {
					url: string;
					method: string;
					headers: Record<string, string>;
					postData?: string;
				};
				if (request.url.startsWith("data:")) return;
				const id = String(params.requestId);
				tab.network.delete(id);
				tab.network.set(id, {
					id,
					method: request.method,
					url: request.url,
					type: params.type as string | undefined,
					requestHeaders: request.headers,
					postData: request.postData,
				});
				if (tab.network.size > BUFFER_LIMIT) tab.network.delete(tab.network.keys().next().value as string);
				return;
			}
			case "Network.responseReceived": {
				const entry = tab.network.get(String(params.requestId));
				if (!entry) return;
				const response = params.response as {
					status: number;
					statusText: string;
					mimeType: string;
					headers: Record<string, string>;
				};
				entry.status = response.status;
				entry.statusText = response.statusText;
				entry.mimeType = response.mimeType;
				entry.responseHeaders = response.headers;
				return;
			}
			case "Network.loadingFinished": {
				const entry = tab.network.get(String(params.requestId));
				if (entry) entry.size = params.encodedDataLength as number;
				return;
			}
			case "Network.loadingFailed": {
				const entry = tab.network.get(String(params.requestId));
				if (entry) entry.error = String(params.errorText);
				return;
			}
		}
	}
}

export function resolvePrefix(prefix: string, ids: string[]): string {
	const upper = prefix.toUpperCase();
	const matches = ids.filter((id) => id.toUpperCase().startsWith(upper));
	if (matches.length === 1) return matches[0] as string;
	if (matches.length === 0) throw new Error(`No tab matches ${prefix}`);
	throw new Error(`Tab prefix ${prefix} is ambiguous (${matches.length} matches)`);
}
