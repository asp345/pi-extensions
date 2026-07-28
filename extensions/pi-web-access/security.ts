import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { errorMessage } from "./storage.ts";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
interface DomainPolicy {
	allow: string[];
	deny: string[];
}
export interface SsrfOptions {
	lookup?: Lookup;
	allowRanges?: string[];
	trustEnvProxy?: boolean;
	domainPolicy?: DomainPolicy;
}

interface Cidr {
	bytes: Uint8Array;
	prefix: number;
}
interface WebConfig {
	ssrf?: { allowRanges?: unknown; trustEnvProxy?: unknown };
	fetchContent?: { domainPolicy?: { allow?: unknown; deny?: unknown } };
}

export function configPath(): string {
	const root =
		process.env.PI_CODING_AGENT_DIR ??
		(process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"));
	return join(root, "web-search.json");
}

export function readWebConfig(): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${errorMessage(error)}`);
	}
}

export function loadSsrfOptions(): SsrfOptions {
	const config = readWebConfig() as WebConfig;
	const rawRanges = config.ssrf?.allowRanges ?? [];
	if (!Array.isArray(rawRanges) || rawRanges.some((value) => typeof value !== "string")) {
		throw new Error(`ssrf.allowRanges in ${configPath()} must be an array of CIDR strings`);
	}
	const allowRanges = rawRanges.map((value) => (value as string).trim()).filter(Boolean);
	if (config.ssrf?.trustEnvProxy !== undefined && typeof config.ssrf.trustEnvProxy !== "boolean") {
		throw new Error(`ssrf.trustEnvProxy in ${configPath()} must be a boolean`);
	}
	return {
		allowRanges,
		trustEnvProxy: config.ssrf?.trustEnvProxy === true,
		domainPolicy: {
			allow: parseDomains(config.fetchContent?.domainPolicy?.allow, "allow"),
			deny: parseDomains(config.fetchContent?.domainPolicy?.deny, "deny"),
		},
	};
}

interface ValidatedTarget {
	url: URL;
	pinnedAddress?: string;
}

export async function validateTarget(
	input: string | URL,
	options: SsrfOptions = loadSsrfOptions(),
): Promise<ValidatedTarget> {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs are allowed");
	if (url.username || url.password) throw new Error("URL credentials are not allowed");
	const hostname = normalizeHost(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost"))
		throw new Error(`Blocked internal hostname: ${hostname}`);
	assertDomainPolicy(hostname, options.domainPolicy);
	const ranges = parseRanges(options.allowRanges ?? []);
	if (net.isIP(hostname)) {
		assertPublic(hostname, hostname, ranges);
		return { url };
	}
	if (options.trustEnvProxy && hasProxy(url) && !matchesNoProxy(url)) return { url };
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await (options.lookup ?? defaultLookup)(hostname);
	} catch (error) {
		throw new Error(`Failed to resolve ${hostname}: ${errorMessage(error)}`);
	}
	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const entry of addresses) assertPublic(entry.address, hostname, ranges);
	return { url, pinnedAddress: addresses[0].address };
}

async function pinnedFetch(url: URL, init: RequestInit, address: string): Promise<Response> {
	const family = net.isIP(address);
	const headers: Record<string, string> = {};
	new Headers(init.headers).forEach((value, name) => {
		headers[name] = value;
	});
	let body: Buffer | undefined;
	if (init.body !== undefined && init.body !== null) {
		const probe = new Response(init.body);
		body = Buffer.from(await probe.arrayBuffer());
		const type = probe.headers.get("content-type");
		if (type && !("content-type" in headers)) headers["content-type"] = type;
	}
	return new Promise<Response>((resolve, reject) => {
		const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = requestFn(
			url,
			{
				method: init.method ?? "GET",
				headers,
				signal: init.signal ?? undefined,
				lookup: (_hostname, lookupOptions, callback) =>
					lookupOptions.all ? callback(null, [{ address, family }]) : callback(null, address, family),
			},
			(incoming: IncomingMessage) => {
				try {
					const status = incoming.statusCode ?? 0;
					if (status < 200 || status > 599) throw new Error(`Invalid HTTP status: ${status}`);
					const responseHeaders = new Headers();
					for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
						try {
							responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
						} catch {}
					}
					const hasBody = status !== 204 && status !== 205 && status !== 304;
					if (!hasBody) incoming.resume();
					const stream = hasBody ? (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>) : null;
					resolve(new Response(stream, { status, statusText: incoming.statusMessage ?? "", headers: responseHeaders }));
				} catch (error) {
					incoming.destroy();
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			},
		);
		request.on("error", reject);
		request.end(body);
	});
}

export async function fetchRemote(
	input: string | URL,
	init: RequestInit = {},
	options: SsrfOptions & { maxRedirects?: number; fetch?: typeof fetch } = {},
): Promise<Response> {
	const resolvedOptions = { ...loadSsrfOptions(), ...options };
	let current = await validateTarget(input, resolvedOptions);
	let request = { ...init, headers: new Headers(init.headers), redirect: "manual" as const };
	const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
	for (let count = 0; count <= maxRedirects; count++) {
		const response = options.fetch
			? await options.fetch(current.url, request)
			: current.pinnedAddress
				? await pinnedFetch(current.url, request, current.pinnedAddress)
				: await fetch(current.url, request);
		if (!REDIRECTS.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		await response.body?.cancel();
		if (count === maxRedirects) throw new Error(`Too many redirects fetching ${current.url}`);
		const next = await validateTarget(new URL(location, current.url), resolvedOptions);
		if (next.url.origin !== current.url.origin) {
			const headers = new Headers(request.headers);
			for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) headers.delete(name);
			request = { ...request, headers };
		}
		if (
			response.status === 303 ||
			((response.status === 301 || response.status === 302) && request.method?.toUpperCase() === "POST")
		) {
			request = { ...request, method: "GET", body: undefined };
		}
		current = next;
	}
	throw new Error("Too many redirects");
}

function parseDomains(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`fetchContent.domainPolicy.${field} in ${configPath()} must be an array of hostnames`);
	}
	const hosts: string[] = [];
	for (const item of value) {
		const host = normalizeHost((item as string).trim());
		if (!host || /[\\/?:#@\s]/.test(host)) throw new Error(`Invalid hostname in fetchContent.domainPolicy.${field}`);
		hosts.push(host);
	}
	return hosts;
}

function assertDomainPolicy(host: string, policy?: DomainPolicy): void {
	if (!policy) return;
	const matches = (entry: string) => host === entry || host.endsWith(`.${entry}`);
	if (policy.deny.some(matches)) throw new Error(`Blocked hostname by fetch_content policy: ${host}`);
	if (policy.allow.length && !policy.allow.some(matches))
		throw new Error(`Hostname not allowed by fetch_content policy: ${host}`);
}

async function defaultLookup(hostname: string) {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeHost(host: string): string {
	return host
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

function hasProxy(url: URL): boolean {
	const names =
		url.protocol === "https:"
			? ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
			: ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
	return names.some((name) => {
		try {
			const value = process.env[name];
			if (!value) return false;
			const proxy = new URL(value);
			return (proxy.protocol === "http:" || proxy.protocol === "https:") && Boolean(proxy.hostname);
		} catch {
			return false;
		}
	});
}

function matchesNoProxy(url: URL): boolean {
	const host = normalizeHost(url.hostname);
	return (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").some((raw) => {
		let entry = raw.trim().toLowerCase();
		if (!entry) return false;
		if (entry === "*") return true;
		if (entry.startsWith("*.")) entry = entry.slice(1);
		if (!entry.startsWith(".")) entry = `.${entry.split(":")[0]}`;
		return host === entry.slice(1) || host.endsWith(entry);
	});
}

function assertPublic(address: string, hostname: string, allow: Cidr[]): void {
	const host = normalizeHost(address);
	const version = net.isIP(host);
	if (!version) throw new Error(`Resolved non-IP address for ${hostname}`);
	const bytes = ipBytes(host, version);
	if (
		bytes &&
		allow.some((range) => range.bytes.length === bytes.length && prefixMatches(bytes, range.bytes, range.prefix))
	)
		return;
	if ((version === 4 && blockedV4(host)) || (version === 6 && blockedV6(host))) {
		throw new Error(`Blocked internal address for ${hostname}: ${host}`);
	}
}

function blockedV4(address: string): boolean {
	const [a, b] = address.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function blockedV6(address: string): boolean {
	const groups = parseV6(address);
	if (!groups) return true;
	if (groups.every((group) => group === 0)) return true;
	if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
	if ((groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xff00) === 0xff00)
		return true;
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		return blockedV4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join("."));
	}
	return false;
}

function parseRanges(values: string[]): Cidr[] {
	return values.map((value) => {
		const [address, rawPrefix, extra] = value.split("/");
		if (extra !== undefined) throw new Error(`Invalid CIDR in ssrf.allowRanges: ${value}`);
		const version = net.isIP(address);
		const max = version === 4 ? 32 : version === 6 ? 128 : 0;
		const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
		const bytes = ipBytes(address, version);
		if (!bytes || !/^\d+$/.test(rawPrefix ?? String(max)) || prefix < 1 || prefix > max) {
			throw new Error(`Invalid CIDR in ssrf.allowRanges: ${value}`);
		}
		return { bytes, prefix };
	});
}

function ipBytes(address: string, version: number): Uint8Array | null {
	if (version === 4) return Uint8Array.from(address.split(".").map(Number));
	const groups = version === 6 ? parseV6(address) : null;
	if (!groups) return null;
	return Uint8Array.from(groups.flatMap((group) => [group >> 8, group & 255]));
}

function parseV6(input: string): number[] | null {
	let address = input;
	if (address.includes(".")) {
		const index = address.lastIndexOf(":");
		const octets = address
			.slice(index + 1)
			.split(".")
			.map(Number);
		if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return null;
		address = `${address.slice(0, index)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
	const groups = [...left, ...Array(missing).fill("0"), ...right].map((value) =>
		/^[0-9a-f]{1,4}$/i.test(value) ? parseInt(value, 16) : -1,
	);
	return groups.length === 8 && groups.every((value) => value >= 0) ? groups : null;
}

function prefixMatches(value: Uint8Array, network: Uint8Array, prefix: number): boolean {
	const bytes = Math.floor(prefix / 8);
	for (let index = 0; index < bytes; index++) if (value[index] !== network[index]) return false;
	const bits = prefix % 8;
	if (!bits) return true;
	const mask = (0xff << (8 - bits)) & 0xff;
	return (value[bytes] & mask) === (network[bytes] & mask);
}
