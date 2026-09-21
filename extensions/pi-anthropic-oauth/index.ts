import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REMOTE_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const LOCAL_REDIRECT = "http://localhost:53692/callback";
const SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
].join(" ");

const CLAUDE_CODE_VERSION = "2.1.278";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`;
const CLAUDE_CODE_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07,mid-conversation-output-config-2026-07-01,fine-grained-tool-streaming-2025-05-14,server-side-fallback-2026-07-01";
const CLAUDE_CODE_BILLING_SALT = "59cf53e54c78";

type Authorization = { code: string; state: string };

class OAuthRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createPkce() {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function authorizationUrl(challenge: string, state: string, redirect: string) {
	return `${AUTHORIZE_URL}?${new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirect,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
	})}`;
}

function parseAuthorization(input: string): Partial<Authorization> {
	const value = input.trim();
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value || undefined };
}

async function callbackServer(expectedState: string) {
	const server = createServer();
	let settle!: (value?: Authorization) => void;
	const result = new Promise<Authorization | undefined>((resolve) => {
		settle = resolve;
	});
	const timeout = setTimeout(() => settle(), 5 * 60_000);
	server.on("request", (request, response) => {
		const url = new URL(request.url ?? "/", LOCAL_REDIRECT);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (url.pathname !== "/callback" || !code || state !== expectedState) {
			response.writeHead(400).end("Invalid authorization callback");
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(
			"<!doctype html><title>Authorization complete</title><h1>Authorization complete</h1><p>You can return to Pi.</p>",
		);
		settle({ code, state });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(53692, "127.0.0.1", resolve);
	});
	return {
		result,
		close: () => {
			clearTimeout(timeout);
			settle();
			server.closeAllConnections();
			server.close();
		},
	};
}

async function tokenRequest(body: Record<string, string>, signal?: AbortSignal) {
	let status = 0;
	let error = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (response.ok) return response;
		status = response.status;
		error = `${response.status} ${await response.text()}`;
		if (
			response.headers.get("x-should-retry") === "false" ||
			(response.status !== 429 && response.status < 500) ||
			attempt === 2
		)
			break;
		const retryAfter = Number(response.headers.get("retry-after"));
		const delay = retryAfter > 0 ? Math.min(retryAfter * 1_000, 30_000) : 5_000 * 2 ** attempt;
		await sleep(delay, undefined, { signal });
	}
	throw new OAuthRequestError(status, `Anthropic OAuth request failed: ${error}`);
}

async function requestCredentials(
	body: Record<string, string>,
	fallbackRefresh: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const token = (await (await tokenRequest(body, signal)).json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};
	const hardExpires = Date.now() + token.expires_in * 1_000;
	return {
		access: token.access_token,
		refresh: token.refresh_token || fallbackRefresh,
		expires: hardExpires - 5 * 60_000,
		hardExpires,
	};
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await createPkce();
	const state = crypto.randomUUID().replace(/-/g, "");
	let redirect = REMOTE_REDIRECT;
	let authorization: Partial<Authorization> | undefined;
	let server: Awaited<ReturnType<typeof callbackServer>> | undefined;
	try {
		server = await callbackServer(state);
	} catch {}
	if (server) {
		try {
			redirect = LOCAL_REDIRECT;
			callbacks.onAuth({
				url: authorizationUrl(challenge, state, redirect),
				instructions: "Complete login in your browser, or paste the final redirect URL.",
			});
			authorization = callbacks.onManualCodeInput
				? await Promise.race([server.result, callbacks.onManualCodeInput().then(parseAuthorization)])
				: await server.result;
		} finally {
			server.close();
		}
	}

	if (!authorization?.code) {
		redirect = REMOTE_REDIRECT;
		callbacks.onAuth({
			url: authorizationUrl(challenge, state, redirect),
			instructions: "Sign in, then paste the callback URL or code#state value.",
		});
		authorization = parseAuthorization(await callbacks.onPrompt({ message: "Paste the callback URL or code#state:" }));
	}
	if (!authorization.code) throw new Error("Missing authorization code.");
	if (authorization.state && authorization.state !== state) {
		throw new Error("OAuth state mismatch.");
	}

	return requestCredentials(
		{
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: authorization.code,
			state: authorization.state ?? state,
			redirect_uri: redirect,
			code_verifier: verifier,
		},
		"",
		callbacks.signal,
	);
}

async function refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	try {
		return await requestCredentials(
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: credentials.refresh,
			},
			credentials.refresh,
		);
	} catch (error) {
		const transient = error instanceof OAuthRequestError && (error.status === 429 || error.status >= 500);
		const hardExpires = typeof credentials.hardExpires === "number" ? credentials.hardExpires : credentials.expires;
		if (transient && hardExpires > Date.now()) {
			return { ...credentials, expires: Math.min(Date.now() + 30_000, hardExpires) };
		}
		throw error;
	}
}

type ClaudeCodeIdentity = { deviceId: string; accountUuid: string };

let cachedIdentity: ClaudeCodeIdentity | undefined;
let identityLoaded = false;

async function loadClaudeCodeIdentity(): Promise<ClaudeCodeIdentity | undefined> {
	if (identityLoaded) return cachedIdentity;
	identityLoaded = true;
	try {
		const raw = await readFile(`${homedir()}/.claude.json`, "utf8");
		const data = JSON.parse(raw) as { userID?: unknown; oauthAccount?: { accountUuid?: unknown } };
		if (typeof data.userID === "string" && typeof data.oauthAccount?.accountUuid === "string") {
			cachedIdentity = { deviceId: data.userID, accountUuid: data.oauthAccount.accountUuid };
		}
	} catch {}
	return cachedIdentity;
}

let cachedSessionId: string | undefined;

function claudeCodeSessionId(): string {
	cachedSessionId ??= crypto.randomUUID();
	return cachedSessionId;
}

function billingVersionSuffix(text: string): string {
	const sampled = [4, 7, 20].map((index) => text[index] ?? "0").join("");
	return createHash("sha256")
		.update(`${CLAUDE_CODE_BILLING_SALT}${sampled}${CLAUDE_CODE_VERSION}`)
		.digest("hex")
		.slice(0, 3);
}

function firstUserText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const role = (message as { role?: unknown }).role;
		const content = (message as { content?: unknown }).content;
		if (role !== "user") continue;
		if (typeof content === "string" && content.length > 0) return content;
		if (Array.isArray(content)) {
			const texts = content.filter(
				(block): block is { type: string; text: string } =>
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			);
			if (texts.length > 0) return texts[texts.length - 1].text;
		}
	}
	return "";
}

const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER = "cch=00000";
const BILLING_SYSTEM_MARKER = `"system":[{"type":"text","text":"x-anthropic-billing-header:`;
const CCH_SEARCH_WINDOW = 200;
const CCH_EXCLUDED_KEYS = new Set(['"max_tokens"', '"fallbacks"', '"fallback_credit_token"']);

const XXH64_MASK = 0xffffffffffffffffn;
const XXH64_P1 = 0x9e3779b185ebca87n;
const XXH64_P2 = 0xc2b2ae3d27d4eb4fn;
const XXH64_P3 = 0x165667b19e3779f9n;
const XXH64_P4 = 0x85ebca77c2b2ae63n;
const XXH64_P5 = 0x27d4eb2f165667c5n;

function xxh64Rotl(value: bigint, shift: bigint): bigint {
	return ((value << shift) | (value >> (64n - shift))) & XXH64_MASK;
}

function xxh64Round(acc: bigint, lane: bigint): bigint {
	return (xxh64Rotl((acc + lane * XXH64_P2) & XXH64_MASK, 31n) * XXH64_P1) & XXH64_MASK;
}

function xxh64U32(data: Uint8Array, offset: number): bigint {
	return (
		BigInt(data[offset]) |
		(BigInt(data[offset + 1]) << 8n) |
		(BigInt(data[offset + 2]) << 16n) |
		(BigInt(data[offset + 3]) << 24n)
	);
}

function xxh64U64(data: Uint8Array, offset: number): bigint {
	return (
		BigInt(data[offset]) |
		(BigInt(data[offset + 1]) << 8n) |
		(BigInt(data[offset + 2]) << 16n) |
		(BigInt(data[offset + 3]) << 24n) |
		(BigInt(data[offset + 4]) << 32n) |
		(BigInt(data[offset + 5]) << 40n) |
		(BigInt(data[offset + 6]) << 48n) |
		(BigInt(data[offset + 7]) << 56n)
	);
}

function xxHash64(data: Uint8Array, seed: bigint): bigint {
	const length = data.length;
	let pos = 0;
	let hash: bigint;
	if (length >= 32) {
		let v1 = (seed + XXH64_P1 + XXH64_P2) & XXH64_MASK;
		let v2 = (seed + XXH64_P2) & XXH64_MASK;
		let v3 = seed & XXH64_MASK;
		let v4 = (seed - XXH64_P1) & XXH64_MASK;
		while (pos + 32 <= length) {
			v1 = xxh64Round(v1, xxh64U64(data, pos));
			v2 = xxh64Round(v2, xxh64U64(data, pos + 8));
			v3 = xxh64Round(v3, xxh64U64(data, pos + 16));
			v4 = xxh64Round(v4, xxh64U64(data, pos + 24));
			pos += 32;
		}
		hash = (xxh64Rotl(v1, 1n) + xxh64Rotl(v2, 7n) + xxh64Rotl(v3, 12n) + xxh64Rotl(v4, 18n)) & XXH64_MASK;
		for (const v of [v1, v2, v3, v4]) {
			hash ^= xxh64Round(0n, v);
			hash = (hash * XXH64_P1 + XXH64_P4) & XXH64_MASK;
		}
	} else {
		hash = (seed + XXH64_P5) & XXH64_MASK;
	}
	hash = (hash + BigInt(length)) & XXH64_MASK;
	while (pos + 8 <= length) {
		hash ^= xxh64Round(0n, xxh64U64(data, pos));
		hash = (xxh64Rotl(hash, 27n) * XXH64_P1 + XXH64_P4) & XXH64_MASK;
		pos += 8;
	}
	if (pos + 4 <= length) {
		hash ^= (xxh64U32(data, pos) * XXH64_P1) & XXH64_MASK;
		hash = (xxh64Rotl(hash, 23n) * XXH64_P2 + XXH64_P3) & XXH64_MASK;
		pos += 4;
	}
	while (pos < length) {
		hash ^= (BigInt(data[pos]) * XXH64_P5) & XXH64_MASK;
		hash = (xxh64Rotl(hash, 11n) * XXH64_P1) & XXH64_MASK;
		pos += 1;
	}
	hash ^= hash >> 33n;
	hash = (hash * XXH64_P2) & XXH64_MASK;
	hash ^= hash >> 29n;
	hash = (hash * XXH64_P3) & XXH64_MASK;
	hash ^= hash >> 32n;
	return hash;
}

type CchEdit = { start: number; end: number };
type CchMember = { start: number; end: number; commaBefore: number; commaAfter: number; excluded: boolean };

class CchScanner {
	pos = 0;
	edits: CchEdit[] = [];
	constructor(private body: Uint8Array) {}

	skipWhitespace(): void {
		while (this.pos < this.body.length) {
			const byte = this.body[this.pos];
			if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) this.pos += 1;
			else return;
		}
	}

	consume(byte: number): boolean {
		if (this.pos < this.body.length && this.body[this.pos] === byte) {
			this.pos += 1;
			return true;
		}
		return false;
	}

	parseString(): [number, number] {
		if (this.body[this.pos] !== 0x22) throw new Error(`Missing JSON string at byte ${this.pos}`);
		const start = this.pos;
		this.pos += 1;
		while (this.pos < this.body.length) {
			const byte = this.body[this.pos];
			if (byte === 0x5c) this.pos += 2;
			else if (byte === 0x22) {
				this.pos += 1;
				return [start, this.pos];
			} else this.pos += 1;
		}
		throw new Error(`Unterminated JSON string at byte ${start}`);
	}

	matchWord(word: string): boolean {
		if (this.pos + word.length > this.body.length) return false;
		for (let i = 0; i < word.length; i++) {
			if (this.body[this.pos + i] !== word.charCodeAt(i)) return false;
		}
		this.pos += word.length;
		return true;
	}

	parseValue(collect: boolean): void {
		this.skipWhitespace();
		const byte = this.body[this.pos];
		if (byte === 0x7b) this.parseObject(collect);
		else if (byte === 0x5b) this.parseArray(collect);
		else if (byte === 0x22) this.parseString();
		else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
			while (this.pos < this.body.length && "-+0123456789.eE".includes(String.fromCharCode(this.body[this.pos]))) {
				this.pos += 1;
			}
		} else if (!this.matchWord("true") && !this.matchWord("false") && !this.matchWord("null")) {
			throw new Error(`Unexpected JSON value at byte ${this.pos}`);
		}
	}

	parseObject(collect: boolean): void {
		this.pos += 1;
		this.skipWhitespace();
		if (this.consume(0x7d)) return;
		const members: CchMember[] = [];
		let commaBefore = -1;
		for (;;) {
			this.skipWhitespace();
			const memberStart = this.pos;
			const [keyStart, keyEnd] = this.parseString();
			this.skipWhitespace();
			if (!this.consume(0x3a)) throw new Error(`Missing object colon at byte ${this.pos}`);
			this.skipWhitespace();
			const key = textDecoder.decode(this.body.subarray(keyStart, keyEnd));
			const excluded = collect && CCH_EXCLUDED_KEYS.has(key);
			if (collect && key === '"model"' && this.pos < this.body.length && this.body[this.pos] === 0x22) {
				const [valueStart, valueEnd] = this.parseString();
				this.addEdit(valueStart + 1, valueEnd - 1);
			} else {
				this.parseValue(collect && !excluded);
			}
			const memberEnd = this.pos;
			this.skipWhitespace();
			let commaAfter = -1;
			if (this.consume(0x2c)) commaAfter = this.pos - 1;
			members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });
			if (commaAfter >= 0) {
				commaBefore = commaAfter;
				continue;
			}
			if (!this.consume(0x7d)) throw new Error(`Missing object end at byte ${this.pos}`);
			break;
		}
		if (collect) this.addExcludedMemberEdits(members);
	}

	parseArray(collect: boolean): void {
		this.pos += 1;
		this.skipWhitespace();
		if (this.consume(0x5d)) return;
		for (;;) {
			this.parseValue(collect);
			this.skipWhitespace();
			if (this.consume(0x2c)) continue;
			if (!this.consume(0x5d)) throw new Error(`Missing array end at byte ${this.pos}`);
			return;
		}
	}

	addExcludedMemberEdits(members: CchMember[]): void {
		let start = 0;
		while (start < members.length) {
			if (!members[start].excluded) {
				start += 1;
				continue;
			}
			let end = start;
			while (end + 1 < members.length && members[end + 1].excluded) end += 1;
			if (end + 1 < members.length) {
				this.addEdit(members[start].start, members[end].commaAfter + 1);
			} else if (start > 0 && end > start) {
				this.addEdit(members[start].start, members[end].end);
			} else if (start > 0) {
				this.addEdit(members[start].commaBefore, members[end].end);
			} else {
				this.addEdit(members[start].start, members[end].end);
			}
			start = end + 1;
		}
	}

	addEdit(start: number, end: number): void {
		if (start < end) this.edits.push({ start, end });
	}
}

function normalizeCchInput(body: Uint8Array): Uint8Array {
	const scanner = new CchScanner(body);
	scanner.parseValue(true);
	scanner.skipWhitespace();
	if (scanner.pos !== body.length) throw new Error(`Unexpected JSON data at byte ${scanner.pos}`);
	const edits = [...scanner.edits].sort((a, b) => a.start - b.start);
	const parts: Uint8Array[] = [];
	let last = 0;
	for (const edit of edits) {
		if (edit.start < last || edit.end > body.length) throw new Error(`Overlapping CCH edit at byte ${edit.start}`);
		parts.push(body.subarray(last, edit.start));
		last = edit.end;
	}
	parts.push(body.subarray(last));
	const normalized = new Uint8Array(body.length - (body.length - parts.reduce((n, p) => n + p.length, 0)));
	let offset = 0;
	for (const part of parts) {
		normalized.set(part, offset);
		offset += part.length;
	}
	return normalized.subarray(0, offset);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0, to = haystack.length): number {
	const end = Math.min(to, haystack.length) - needle.length;
	outer: for (let i = from; i <= end; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function patchCch(body: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
	const marker = textEncoder.encode(BILLING_SYSTEM_MARKER);
	const markerIdx = indexOfBytes(body, marker);
	if (markerIdx === -1) return undefined;
	const searchFrom = markerIdx + marker.length;
	const placeholder = textEncoder.encode(`${CCH_PLACEHOLDER};`);
	const idx = indexOfBytes(body, placeholder, searchFrom, searchFrom + CCH_SEARCH_WINDOW);
	if (idx === -1) return undefined;
	const unsigned = new Uint8Array(body.length);
	unsigned.set(body);
	const normalized = normalizeCchInput(unsigned);
	const digest = xxHash64(normalized, CCH_SEED) & 0xfffffn;
	const hex = digest.toString(16).padStart(5, "0");
	for (let i = 0; i < 5; i++) unsigned[idx + 4 + i] = hex.charCodeAt(i);
	return unsigned;
}

function wrapFetchForCch(base: typeof globalThis.fetch): typeof globalThis.fetch {
	return ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		try {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
			const text = init?.body;
			if (url?.includes("/v1/messages") && typeof text === "string" && text.includes(BILLING_SYSTEM_MARKER)) {
				const patched = patchCch(textEncoder.encode(text));
				if (patched) return base(input, { ...init, body: patched });
			}
		} catch {}
		return base(input, init);
	}) as typeof globalThis.fetch;
}

function stream(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (apiKey && !apiKey.includes("sk-ant-oat")) {
				const inner = anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, options);
				for await (const event of inner) outer.push(event);
				return;
			}
			const sessionId = claudeCodeSessionId();
			const requestId = crypto.randomUUID();
			const promptId = crypto.randomUUID();
			const identity = await loadClaudeCodeIdentity();
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const userId = identity
				? JSON.stringify({ device_id: identity.deviceId, account_uuid: identity.accountUuid, session_id: sessionId })
				: undefined;
			const previousOnPayload = options?.onPayload;
			const innerOptions: SimpleStreamOptions = {
				...options,
				headers: {
					...options?.headers,
					"User-Agent": CLAUDE_CODE_USER_AGENT,
					"user-agent": CLAUDE_CODE_USER_AGENT,
					"anthropic-beta": CLAUDE_CODE_BETA,
					"X-Claude-Code-Session-Id": sessionId,
					"x-claude-code-request-class": "main",
					"x-client-request-id": requestId,
				},
				fetch: wrapFetchForCch(options?.fetch ?? globalThis.fetch),
				...(userId ? { metadata: { ...options?.metadata, user_id: userId } } : {}),
				onPayload: async (payload: unknown, innerModel: Model<Api>) => {
					const next = (await previousOnPayload?.(payload, innerModel)) ?? payload;
					const params = next as Record<string, unknown>;
					const suffix = billingVersionSuffix(firstUserText(params.messages));
					const billing =
						`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
						`cc_entrypoint=sdk-cli; ${CCH_PLACEHOLDER}; cc_prompt_id=${promptId}; cc_turn_origin=sdk;`;
					const system = Array.isArray(params.system) ? [...(params.system as unknown[])] : [];
					system.unshift({ type: "text", text: billing });
					params.system = system;
					params.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
					params.diagnostics = { previous_message_id: null };
					return params;
				},
			};
			const inner = anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, innerOptions);
			for await (const event of inner) outer.push(event);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outer.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: message,
					timestamp: Date.now(),
				},
			});
		} finally {
			outer.end();
		}
	})();
	return outer;
}

export default function anthropicOAuth(pi: ExtensionAPI): void {
	pi.registerProvider("anthropic", {
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages",
		oauth: {
			name: "Claude Pro/Max",
			usesCallbackServer: true,
			login,
			refreshToken: refresh,
			getApiKey: (credentials: OAuthCredentials) => credentials.access,
		},
		streamSimple: stream,
	});
}
