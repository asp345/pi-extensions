/**
 * Request metadata (requestId, sessionId, labels) reproducing the agy CLI
 * 1.1.20 agent wire format captured on 2026-08-25:
 *   requestId: "agent/<conversationId>/<epochMs>/<trajectoryId>/<stepIndex+1>"
 *   labels.request_id: "<trajectoryId>-<lastStepIndex>"
 */
import { randomUUID } from "node:crypto";

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_STATES = 256;

/** Field order observed in agy 1.1.20 request payloads. */
const AGY_REQUEST_FIELD_ORDER = [
	"contents",
	"systemInstruction",
	"tools",
	"labels",
	"generationConfig",
	"sessionId",
] as const;

// model_enum label values captured from fetchAvailableModels/labels traffic.
const AGY_MODEL_ENUM_BY_WIRE_MODEL: Record<string, string> = {
	"gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
	"gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
	"gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
	"gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
	"gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
	"gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
	"gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
	"gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
	"gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
	"gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
	"gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
	"claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
	"claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
	"gemini-3.1-flash-image": "MODEL_PLACEHOLDER_M21",
	"gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

export interface AgySessionContext {
	conversationId: string;
	trajectoryId: string;
	numericSessionId: string;
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

function createSessionContext(workspaceUri: string): AgySessionContext {
	return {
		conversationId: randomUUID(),
		trajectoryId: randomUUID(),
		numericSessionId: fnv1a64Signed(workspaceUri),
	};
}

interface SessionEntry {
	context: AgySessionContext;
	lastAccessedAt: number;
	lastRequestTimestamp: number;
}

export class AgyRequestSessionStore {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly workspaceUri: string;
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(workspaceUri: string, options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
		this.workspaceUri = workspaceUri;
		this.ttlMs = options.ttlMs ?? SESSION_STATE_TTL_MS;
		this.maxEntries = options.maxEntries ?? MAX_SESSION_STATES;
		this.now = options.now ?? Date.now;
	}

	beginRequest(key: string): AgyRequestScope {
		const timestamp = this.now();
		this.prune(timestamp, key);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = {
				context: createSessionContext(this.workspaceUri),
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
		const expiry = timestamp - this.ttlMs;
		for (const [key, value] of this.entries) {
			if (key !== preservedKey && value.lastAccessedAt < expiry) this.entries.delete(key);
		}
		while (this.entries.size >= this.maxEntries && !this.entries.has(preservedKey)) {
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

export function getAgyModelEnum(model: string): string | undefined {
	return AGY_MODEL_ENUM_BY_WIRE_MODEL[model.toLowerCase()];
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

export function countAgyRequestSteps(
	payload: { contents?: unknown },
	mode: "parts" | "contents" | "cli" = "parts",
): number {
	const contents = payload.contents;
	if (!Array.isArray(contents)) return 1;
	if (mode === "contents") return Math.max(1, contents.length);
	let partCount = 0;
	let functionResponseCount = 0;
	for (const content of contents) {
		if (!content || typeof content !== "object" || Array.isArray(content)) continue;
		const parts = (content as { parts?: unknown }).parts;
		if (!Array.isArray(parts)) continue;
		partCount += parts.length;
		if (mode === "cli") {
			functionResponseCount += parts.filter((part) => {
				if (!part || typeof part !== "object" || Array.isArray(part)) return false;
				return "functionResponse" in part;
			}).length;
		}
	}
	if (mode === "cli") return Math.max(1, contents.length + functionResponseCount);
	return Math.max(1, partCount);
}

export function buildAgyAgentRequestMetadata(
	session: AgySessionContext,
	payload: { contents?: unknown },
	model: string,
	timestamp: number = Date.now(),
	options: { stepCountMode?: "parts" | "contents" | "cli" } = {},
): { requestId: string; sessionId: string; labels: Record<string, string>; lastStepIndex: number } {
	const lastStepIndex =
		countAgyRequestSteps(payload, options.stepCountMode ?? "parts") + (session.lastExecutionId ? 1 : 0);
	const lowerModel = model.toLowerCase();
	const isClaude = lowerModel.startsWith("claude-");
	const isNonGemini = isClaude || lowerModel.startsWith("gpt-");
	session.usedClaude = session.usedClaude === true || isClaude;
	session.usedNonGeminiModel = session.usedNonGeminiModel === true || isNonGemini;
	const modelEnum = getAgyModelEnum(model);
	const labels: Record<string, string> = {
		...(session.lastExecutionId ? { last_execution_id: session.lastExecutionId } : {}),
		last_step_index: String(lastStepIndex),
		...(modelEnum ? { model_enum: modelEnum } : {}),
		request_id: `${session.trajectoryId}-${lastStepIndex}`,
		trajectory_id: session.trajectoryId,
		used_claude: session.usedClaude ? "true" : "false",
		used_claude_conservative: session.usedClaude ? "true" : "false",
		used_non_gemini_model: session.usedNonGeminiModel ? "true" : "false",
	};
	return {
		requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
		sessionId: session.numericSessionId,
		labels,
		lastStepIndex,
	};
}
