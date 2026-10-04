import { randomUUID } from "node:crypto";

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_STATES = 256;

const AGY_REQUEST_FIELD_ORDER = [
	"contents",
	"systemInstruction",
	"tools",
	"labels",
	"generationConfig",
	"sessionId",
] as const;

interface AgySessionContext {
	conversationId: string;
	trajectoryId: string;
	numericSessionId: string;
	requestCount: number;
	lastExecutionId?: string;
	usedClaude?: boolean;
	usedNonGeminiModel?: boolean;
}

export interface AgyRequestScope {
	session: AgySessionContext;
	timestamp: number;
}

function fnv1a64Signed(input: string): string {
	let hash = FNV1A_64_OFFSET_BASIS;
	for (const byte of Buffer.from(input, "utf8")) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME);
	}
	return BigInt.asIntN(64, hash).toString();
}

const NUMERIC_SESSION_ID = fnv1a64Signed("");

function createSessionContext(): AgySessionContext {
	return {
		conversationId: randomUUID(),
		trajectoryId: randomUUID(),
		numericSessionId: NUMERIC_SESSION_ID,
		requestCount: 0,
	};
}

interface SessionEntry {
	context: AgySessionContext;
	lastAccessedAt: number;
	lastRequestTimestamp: number;
}

export class AgyRequestSessionStore {
	private readonly entries = new Map<string, SessionEntry>();

	beginRequest(key: string): AgyRequestScope {
		const timestamp = Date.now();
		this.prune(timestamp, key);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = {
				context: createSessionContext(),
				lastAccessedAt: timestamp,
				lastRequestTimestamp: 0,
			};
			this.entries.set(key, entry);
		}
		entry.lastAccessedAt = timestamp;
		entry.lastRequestTimestamp = Math.max(entry.lastAccessedAt, entry.lastRequestTimestamp + 1);
		return { session: entry.context, timestamp: entry.lastRequestTimestamp };
	}

	completeExecution(key: string): void {
		const entry = this.entries.get(key);
		if (entry) entry.context.lastExecutionId = randomUUID();
	}

	private prune(timestamp: number, preservedKey: string): void {
		const expiry = timestamp - SESSION_STATE_TTL_MS;
		for (const [key, value] of this.entries) {
			if (key !== preservedKey && value.lastAccessedAt < expiry) this.entries.delete(key);
		}
		while (this.entries.size >= MAX_SESSION_STATES && !this.entries.has(preservedKey)) {
			let oldestKey: string | null = null;
			let oldestAccess = Number.POSITIVE_INFINITY;
			for (const [key, value] of this.entries) {
				if (key !== preservedKey && value.lastAccessedAt < oldestAccess) {
					oldestKey = key;
					oldestAccess = value.lastAccessedAt;
				}
			}
			if (!oldestKey) break;
			this.entries.delete(oldestKey);
		}
	}
}

export function orderAgyRequestPayloadInPlace(payload: Record<string, unknown>): void {
	const ordered: Record<string, unknown> = {};
	const remaining = new Set(Object.keys(payload));
	for (const key of AGY_REQUEST_FIELD_ORDER) {
		if (key in payload) {
			ordered[key] = payload[key];
			remaining.delete(key);
		}
	}
	for (const key of remaining) ordered[key] = payload[key];
	for (const key of Object.keys(payload)) delete payload[key];
	Object.assign(payload, ordered);
}

export function buildAgyAgentRequestMetadata(
	session: AgySessionContext,
	payload: { contents?: unknown },
	model: string,
	modelEnum: string | undefined,
	timestamp: number,
): { requestId: string; sessionId: string; labels: Record<string, string> } {
	const lastStepIndex = Math.max(0, (Array.isArray(payload.contents) ? payload.contents.length : 0) - 1);
	const requestIndex = session.requestCount++;
	const lowerModel = model.toLowerCase();
	const isClaude = lowerModel.startsWith("claude-");
	const isNonGemini = isClaude || lowerModel.startsWith("gpt-");
	session.usedClaude = session.usedClaude === true || isClaude;
	session.usedNonGeminiModel = session.usedNonGeminiModel === true || isNonGemini;
	const labels: Record<string, string> = {
		cascade_id: session.conversationId,
		...(session.lastExecutionId ? { last_execution_id: session.lastExecutionId } : {}),
		last_step_index: String(lastStepIndex),
		...(modelEnum ? { model_enum: modelEnum } : {}),
		request_id: `${session.trajectoryId}-${requestIndex}`,
		root_cascade_id: session.conversationId,
		trajectory_id: session.trajectoryId,
		used_claude: session.usedClaude ? "true" : "false",
		used_claude_conservative: session.usedClaude ? "true" : "false",
		used_non_gemini_model: session.usedNonGeminiModel ? "true" : "false",
	};
	return {
		requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
		sessionId: session.numericSessionId,
		labels,
	};
}
