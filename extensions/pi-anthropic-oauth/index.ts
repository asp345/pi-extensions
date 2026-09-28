import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLAUDE_CODE_VERSION = "2.1.280";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`;
const CLAUDE_CODE_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07,mid-conversation-output-config-2026-07-01,fine-grained-tool-streaming-2025-05-14,server-side-fallback-2026-07-01,compact-2026-09-04";
const CLAUDE_CODE_BILLING_SALT = "59cf53e54c78";
const CLAUDE_CODE_LEGACY_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const SESSION_ID = crypto.randomUUID();

function claudeCodeUserId(): string | undefined {
	const path = `${homedir()}/.claude.json`;
	if (!existsSync(path)) return undefined;
	const data = JSON.parse(readFileSync(path, "utf8")) as { userID?: unknown; oauthAccount?: { accountUuid?: unknown } };
	if (typeof data.userID !== "string" || typeof data.oauthAccount?.accountUuid !== "string") return undefined;
	return JSON.stringify({
		device_id: data.userID,
		account_uuid: data.oauthAccount.accountUuid,
		session_id: SESSION_ID,
	});
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
	return Buffer.concat(parts);
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

function patchCch(body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
	const marker = textEncoder.encode(BILLING_SYSTEM_MARKER);
	const markerIdx = indexOfBytes(body, marker);
	if (markerIdx === -1) return undefined;
	const searchFrom = markerIdx + marker.length;
	const placeholder = textEncoder.encode(`${CCH_PLACEHOLDER};`);
	const idx = indexOfBytes(body, placeholder, searchFrom, searchFrom + CCH_SEARCH_WINDOW);
	if (idx === -1) return undefined;
	const digest = xxHash64(normalizeCchInput(body), CCH_SEED) & 0xfffffn;
	const hex = digest.toString(16).padStart(5, "0");
	for (let i = 0; i < 5; i++) body[idx + 4 + i] = hex.charCodeAt(i);
	return body;
}

function buildBillingPlaceholder(promptId: string, firstUserText: string): string {
	const suffix = billingVersionSuffix(firstUserText);
	return (
		`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
		`cc_entrypoint=sdk-cli; ${CCH_PLACEHOLDER}; cc_prompt_id=${promptId}; cc_turn_origin=sdk;`
	);
}

function wrapFetchForCch(base: typeof globalThis.fetch): typeof globalThis.fetch {
	return ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
		const text = init?.body;
		if (url?.includes("/v1/messages") && typeof text === "string" && text.includes(BILLING_SYSTEM_MARKER)) {
			const patched = patchCch(textEncoder.encode(text));
			if (patched) return base(input, { ...init, body: patched });
		}
		return base(input, init);
	}) as typeof globalThis.fetch;
}

function stream(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	userId: string | undefined,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	if (apiKey && !apiKey.includes("sk-ant-oat")) {
		return anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, options);
	}
	const promptId = crypto.randomUUID();
	const previousOnPayload = options?.onPayload;
	return anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, {
		...options,
		headers: {
			...options?.headers,
			"User-Agent": CLAUDE_CODE_USER_AGENT,
			"user-agent": CLAUDE_CODE_USER_AGENT,
			"anthropic-beta": CLAUDE_CODE_BETA,
			"X-Claude-Code-Session-Id": SESSION_ID,
			"x-claude-code-request-class": "main",
			"x-client-request-id": crypto.randomUUID(),
		},
		fetch: wrapFetchForCch(options?.fetch ?? globalThis.fetch),
		...(userId ? { metadata: { ...options?.metadata, user_id: userId } } : {}),
		onPayload: async (payload: unknown, innerModel: Model<Api>) => {
			const next = (await previousOnPayload?.(payload, innerModel)) ?? payload;
			const params = next as Record<string, unknown>;
			const billing = buildBillingPlaceholder(promptId, firstUserText(params.messages));
			const system = Array.isArray(params.system) ? [...(params.system as unknown[])] : [];
			system.unshift({ type: "text", text: billing });
			const legacy = system[1] as { type?: unknown; text?: unknown } | undefined;
			if (legacy?.type === "text" && legacy.text === CLAUDE_CODE_LEGACY_IDENTITY) {
				system[1] = { type: "text", text: CLAUDE_CODE_IDENTITY };
			}
			params.system = system;
			if (params.compaction === undefined) {
				params.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
			}
			params.diagnostics = { previous_message_id: null };
			return params;
		},
	});
}

export default function anthropicOAuth(pi: ExtensionAPI): void {
	const userId = claudeCodeUserId();
	pi.registerProvider("anthropic", {
		api: "anthropic-messages",
		streamSimple: (model, context, options) => stream(model, context, options, userId),
	});
}
