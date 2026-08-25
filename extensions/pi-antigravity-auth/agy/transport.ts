/**
 * HTTP/1.1 client over node:tls that reproduces the agy CLI wire behavior:
 * chunked transfer encoding for streamGenerateContent, minimal headers,
 * gzip response handling, and CONNECT tunneling through HTTPS_PROXY.
 *
 * Transient TLS handshake failures (observed as ERR_TLS_CERT_ALTNAME_INVALID
 * roughly once per hundred connections on machines behind VPN/corporate
 * networks) are retried because the failure occurs before any request bytes
 * are written, so a retry cannot duplicate a request.
 */
import * as net from "node:net";
import { PassThrough, Readable, Transform } from "node:stream";
import * as tls from "node:tls";
import { createGunzip } from "node:zlib";

const DEFAULT_HTTPS_PORT = 443;
const DEFAULT_PROXY_PORT = 8080;
export const AGY_RESPONSE_HEADER_TIMEOUT_MS = 180_000;
export const AGY_IDLE_TIMEOUT_MS = 180_000;
const TLS_CONNECT_ATTEMPTS = 3;

export interface AgyFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}

export function buildAgyCliHeaderPairs(
	url: URL,
	init: RequestInit & { body?: BodyInit | null },
): Array<[string, string]> {
	const headers = new Headers(init.headers);
	const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
	const userAgent = headers.get("User-Agent") ?? "";
	const authorization = headers.get("Authorization");
	const contentType = headers.get("Content-Type") ?? "application/json";
	const acceptEncoding = headers.get("Accept-Encoding") ?? "gzip";
	const body = init.body == null ? Buffer.alloc(0) : Buffer.from(init.body as string);
	const pairs: Array<[string, string]> = [
		["Host", host],
		["User-Agent", userAgent],
	];
	if (url.pathname.includes(":streamGenerateContent")) {
		pairs.push(["Transfer-Encoding", "chunked"]);
	} else {
		pairs.push(["Content-Length", String(body.byteLength)]);
	}
	if (authorization) pairs.push(["Authorization", authorization]);
	pairs.push(["Content-Type", contentType], ["Accept-Encoding", acceptEncoding]);
	return pairs;
}

function noProxyIncludes(hostname: string): boolean {
	const raw = process.env.NO_PROXY || process.env.no_proxy || "";
	if (!raw) return false;
	const host = hostname.toLowerCase();
	return raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.some((entry) => {
			if (!entry) return false;
			if (entry === "*") return true;
			if (entry.startsWith(".")) return host.endsWith(entry);
			return host === entry || host.endsWith(`.${entry}`);
		});
}

function getHttpsProxy(url: URL): URL | undefined {
	if (url.protocol !== "https:" || noProxyIncludes(url.hostname)) return undefined;
	const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
	if (!rawProxy) return undefined;
	try {
		return new URL(rawProxy);
	} catch {
		return undefined;
	}
}

function waitForHead(
	socket: net.Socket,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<{ head: string; leftover: Buffer }> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timeout = setTimeout(() => {
			onTimeout();
			cleanup(() =>
				reject(new Error(`Antigravity request timed out waiting for response headers after ${timeoutMs}ms`)),
			);
		}, timeoutMs);
		const cleanup = (finish: () => void) => {
			socket.off("data", onData);
			socket.off("error", onError);
			clearTimeout(timeout);
			finish();
		};
		const onError = (error: Error) => cleanup(() => reject(error));
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const marker = buffer.indexOf("\r\n\r\n");
			if (marker === -1) return;
			const head = buffer.subarray(0, marker).toString("latin1");
			const leftover = buffer.subarray(marker + 4);
			cleanup(() => resolve({ head, leftover }));
		};
		socket.on("data", onData);
		socket.once("error", onError);
	});
}

async function connectViaProxy(proxyUrl: URL, targetUrl: URL, timeoutMs: number): Promise<tls.TLSSocket> {
	const proxySocket = net.connect({
		host: proxyUrl.hostname,
		port: Number(proxyUrl.port || DEFAULT_PROXY_PORT),
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			proxySocket.destroy();
			reject(new Error(`Antigravity request timed out connecting to HTTPS proxy after ${timeoutMs}ms`));
		}, timeoutMs);
		proxySocket.once("connect", () => {
			clearTimeout(timeout);
			resolve();
		});
		proxySocket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
	const targetHost = targetUrl.hostname;
	const targetPort = Number(targetUrl.port || DEFAULT_HTTPS_PORT);
	const auth = proxyUrl.username
		? `Proxy-Authorization: Basic ${Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64")}\r\n`
		: "";
	proxySocket.write(
		`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n` + auth + "\r\n",
	);
	const { head, leftover } = await waitForHead(proxySocket, timeoutMs, () => proxySocket.destroy());
	if (!/^HTTP\/1\.[01] 2\d\d\b/.test(head)) {
		proxySocket.destroy();
		throw new Error(`Proxy CONNECT failed: ${head.split("\r\n")[0] ?? "unknown"}`);
	}
	if (leftover.length > 0) proxySocket.unshift(leftover);
	return await new Promise((resolve, reject) => {
		const tlsSocket = tls.connect({ socket: proxySocket, servername: targetHost });
		const timeout = setTimeout(() => {
			tlsSocket.destroy();
			reject(new Error(`Antigravity request timed out during proxy TLS handshake after ${timeoutMs}ms`));
		}, timeoutMs);
		tlsSocket.once("secureConnect", () => {
			clearTimeout(timeout);
			resolve(tlsSocket);
		});
		tlsSocket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function connectDirect(targetUrl: URL, timeoutMs: number): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({
			host: targetUrl.hostname,
			port: Number(targetUrl.port || DEFAULT_HTTPS_PORT),
			servername: targetUrl.hostname,
		});
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Antigravity request timed out connecting after ${timeoutMs}ms`));
		}, timeoutMs);
		socket.once("secureConnect", () => {
			clearTimeout(timeout);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

async function connectTls(targetUrl: URL, timeoutMs: number): Promise<tls.TLSSocket> {
	const proxyUrl = getHttpsProxy(targetUrl);
	return proxyUrl ? await connectViaProxy(proxyUrl, targetUrl, timeoutMs) : await connectDirect(targetUrl, timeoutMs);
}

/**
 * Connect with retry on transient TLS errors. Node throws ERR_TLS_CERT_ALTNAME_INVALID
 * and ERR_TLS_UNEXPECTED_EOF during the handshake when a VPN or TLS-intercepting
 * middlebox briefly serves the wrong certificate; no request bytes have been
 * written at that point, so reconnecting is safe.
 */
async function connectTlsWithRetry(targetUrl: URL, timeoutMs: number, signal?: AbortSignal): Promise<tls.TLSSocket> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= TLS_CONNECT_ATTEMPTS; attempt += 1) {
		if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
		try {
			return await connectTls(targetUrl, timeoutMs);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ERR_TLS_CERT_ALTNAME_INVALID" && code !== "ERR_TLS_UNEXPECTED_EOF") throw error;
			lastError = error;
		}
	}
	throw lastError;
}

function serializeRequest(url: URL, init: RequestInit & { body?: BodyInit | null }, body: Buffer): Buffer {
	const method = init.method ?? "POST";
	const path = `${url.pathname}${url.search}`;
	const headerLines = buildAgyCliHeaderPairs(url, init)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\r\n");
	const head = Buffer.from(`${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
	if (body.byteLength === 0) return head;
	if (!url.pathname.includes(":streamGenerateContent")) return Buffer.concat([head, body]);
	return Buffer.concat([head, Buffer.from(`${body.byteLength.toString(16)}\r\n`), body, Buffer.from("\r\n0\r\n\r\n")]);
}

interface ParsedHead {
	status: number;
	statusText: string;
	headers: Headers;
	chunked: boolean;
	gzip: boolean;
	contentLength?: number;
}

function parseResponseHead(head: string): ParsedHead {
	const lines = head.split("\r\n");
	const statusLine = lines.shift() ?? "";
	const match = /^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/.exec(statusLine);
	if (!match) throw new Error(`Invalid HTTP response: ${statusLine}`);
	const headers = new Headers();
	let chunked = false;
	let gzip = false;
	let contentLength: number | undefined;
	for (const line of lines) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const key = line.slice(0, index);
		const value = line.slice(index + 1).trim();
		const lowerKey = key.toLowerCase();
		const lowerValue = value.toLowerCase();
		if (lowerKey === "transfer-encoding" && lowerValue.includes("chunked")) {
			chunked = true;
			continue;
		}
		if (lowerKey === "content-encoding" && lowerValue.includes("gzip")) {
			gzip = true;
			continue;
		}
		if (lowerKey === "content-length") {
			const parsed = Number.parseInt(value, 10);
			if (Number.isFinite(parsed) && parsed >= 0) contentLength = parsed;
			if (gzip) continue;
		}
		headers.append(key, value);
	}
	return {
		status: Number(match[1]),
		statusText: match[2] ?? "",
		headers,
		chunked,
		gzip,
		contentLength,
	};
}

class ContentLengthStream extends Transform {
	private remaining: number;

	constructor(contentLength: number) {
		super();
		this.remaining = contentLength;
	}

	override _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
		if (this.remaining <= 0) {
			callback();
			return;
		}
		if (chunk.length <= this.remaining) {
			this.remaining -= chunk.length;
			this.push(chunk);
		} else {
			this.push(chunk.subarray(0, this.remaining));
			this.remaining = 0;
		}
		if (this.remaining <= 0) this.push(null);
		callback();
	}
}

class ChunkedDecodeStream extends Transform {
	private buffer = Buffer.alloc(0);

	override _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		try {
			this.flushAvailableChunks();
			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	override _flush(callback: (error?: Error | null) => void): void {
		try {
			this.flushAvailableChunks();
			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private flushAvailableChunks(): void {
		while (true) {
			const lineEnd = this.buffer.indexOf("\r\n");
			if (lineEnd === -1) return;
			const sizeLine = this.buffer.subarray(0, lineEnd).toString("latin1");
			const sizeText = sizeLine.split(";", 1)[0]?.trim() ?? "";
			const size = Number.parseInt(sizeText, 16);
			if (!Number.isFinite(size)) throw new Error(`Invalid chunk size: ${sizeLine}`);
			const chunkStart = lineEnd + 2;
			const chunkEnd = chunkStart + size;
			const nextOffset = chunkEnd + 2;
			if (this.buffer.length < nextOffset) return;
			if (size === 0) {
				this.buffer = Buffer.alloc(0);
				this.push(null);
				return;
			}
			this.push(this.buffer.subarray(chunkStart, chunkEnd));
			this.buffer = this.buffer.subarray(nextOffset);
		}
	}
}

function buildResponseStream(
	socket: net.Socket,
	leftover: Buffer,
	head: ParsedHead,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number,
): ReadableStream<Uint8Array> {
	const source = new PassThrough();
	if (leftover.length > 0) source.write(leftover);
	socket.pipe(source);
	let responseBody: NodeJS.ReadWriteStream = source;
	if (head.chunked) {
		responseBody = responseBody.pipe(new ChunkedDecodeStream());
	} else if (typeof head.contentLength === "number") {
		responseBody = responseBody.pipe(new ContentLengthStream(head.contentLength));
	}
	if (head.gzip) responseBody = responseBody.pipe(createGunzip());

	let idleTimer: NodeJS.Timeout | undefined;
	const clearIdle = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const armIdle = () => {
		if (idleTimeoutMs <= 0) return;
		clearIdle();
		idleTimer = setTimeout(() => {
			socket.destroy(new Error(`Antigravity response stalled: no data for ${idleTimeoutMs}ms`));
		}, idleTimeoutMs);
	};
	socket.on("data", armIdle);
	armIdle();
	const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"));
	const cleanup = () => {
		clearIdle();
		socket.off("data", armIdle);
		signal?.removeEventListener("abort", abort);
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	responseBody.once("end", () => {
		cleanup();
		socket.destroy();
	});
	responseBody.once("error", () => {
		cleanup();
		socket.destroy();
	});
	responseBody.once("close", cleanup);
	return Readable.toWeb(responseBody as unknown as import("node:stream").Readable) as ReadableStream<Uint8Array>;
}

export async function fetchWithAgyCliTransport(
	url: string,
	init: RequestInit & { body?: BodyInit | null } = {},
	options: AgyFetchOptions = {},
): Promise<Response> {
	const parsedUrl = new URL(url);
	if (parsedUrl.protocol !== "https:") {
		throw new Error(`agy transport only supports https URLs: ${url}`);
	}
	if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
	const body = init.body == null ? Buffer.alloc(0) : Buffer.from(init.body as string);
	const requestBytes = serializeRequest(parsedUrl, init, body);
	const timeoutMs = options.timeoutMs ?? AGY_RESPONSE_HEADER_TIMEOUT_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? AGY_IDLE_TIMEOUT_MS;
	const socket = await connectTlsWithRetry(parsedUrl, timeoutMs, options.signal);
	const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"));
	try {
		options.signal?.addEventListener("abort", abort, { once: true });
		socket.write(requestBytes);
		const { head, leftover } = await waitForHead(socket, timeoutMs, () => socket.destroy());
		const parsedHead = parseResponseHead(head);
		const bodyStream = buildResponseStream(socket, leftover, parsedHead, options.signal, idleTimeoutMs);
		return new Response(bodyStream, {
			status: parsedHead.status,
			statusText: parsedHead.statusText,
			headers: parsedHead.headers,
		});
	} catch (error) {
		socket.destroy();
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}
}
