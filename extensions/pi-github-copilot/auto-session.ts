import type { Context, ProviderHeaders } from "@earendil-works/pi-ai";
import { AUTO_MODEL_ID } from "./catalog.ts";

export const COPILOT_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/json",
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": "2026-06-01",
	"Openai-Intent": "conversation-edits",
} as const;

export interface AutoSession {
	availableModels: string[];
	sessionToken: string;
	expiresAt: number;
	interactionId: string;
	chosenModel?: string;
	reasoningBucket?: "low" | "medium" | "high";
}

interface SessionResponse {
	available_models?: unknown;
	selected_model?: unknown;
	session_token?: unknown;
	expires_at?: unknown;
}

interface IntentResponse {
	chosen_model?: unknown;
	candidate_models?: unknown;
	reasoning_bucket?: unknown;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function latestUserPrompt(context: Context): { prompt: string; hasImage: boolean } {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return { prompt: message.content, hasImage: false };

		let prompt = "";
		let hasImage = false;
		for (const part of message.content) {
			if (part.type === "text") prompt += `${prompt ? "\n" : ""}${part.text}`;
			if (part.type === "image") hasImage = true;
		}
		return { prompt, hasImage };
	}
	return { prompt: "", hasImage: false };
}

export function mergeHeaders(base: ProviderHeaders | undefined, extra: Record<string, string>): ProviderHeaders {
	const merged: ProviderHeaders = { ...(base ?? {}) };
	for (const [name, value] of Object.entries(extra)) {
		for (const existing of Object.keys(merged)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
		}
		merged[name] = value;
	}
	return merged;
}

export async function credentialFingerprint(apiKey: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
	return Array.from(new Uint8Array(digest, 0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(15_000);
	const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, { ...init, signal: combinedSignal });
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Copilot Auto ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
	}
	return (await response.json()) as T;
}

export async function createAutoSession(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<AutoSession> {
	const interactionId = crypto.randomUUID();
	const response = await fetchJson<SessionResponse>(
		`${baseUrl}/models/session`,
		{
			method: "POST",
			headers: {
				...COPILOT_HEADERS,
				Authorization: `Bearer ${apiKey}`,
				"X-Initiator": "user",
				"X-Interaction-Id": interactionId,
			},
			body: JSON.stringify({ auto_mode: { model_hints: [AUTO_MODEL_ID] } }),
		},
		signal,
	);

	const availableModels = stringList(response.available_models);
	if (availableModels.length === 0 || typeof response.session_token !== "string") {
		throw new Error("Copilot Auto returned an invalid model session");
	}

	const now = Date.now();
	const reportedExpiry = typeof response.expires_at === "number" ? response.expires_at * 1000 : 0;
	const expiresAt =
		reportedExpiry > now + 30_000 && reportedExpiry < now + 24 * 60 * 60_000 ? reportedExpiry : now + 10 * 60_000;
	return {
		availableModels,
		sessionToken: response.session_token,
		expiresAt,
		interactionId,
		chosenModel: typeof response.selected_model === "string" ? response.selected_model : availableModels[0],
	};
}

export async function routePrompt(
	baseUrl: string,
	apiKey: string,
	state: AutoSession,
	context: Context,
	signal?: AbortSignal,
): Promise<void> {
	const { prompt, hasImage } = latestUserPrompt(context);
	const response = await fetchJson<IntentResponse>(
		`${baseUrl}/models/session/intent`,
		{
			method: "POST",
			headers: {
				...COPILOT_HEADERS,
				Authorization: `Bearer ${apiKey}`,
				"Copilot-Session-Token": state.sessionToken,
				"X-Initiator": "user",
				"X-Interaction-Id": state.interactionId,
			},
			body: JSON.stringify({ prompt, available_models: state.availableModels, has_image: hasImage }),
		},
		signal,
	);

	const candidates = stringList(response.candidate_models);
	const chosen = typeof response.chosen_model === "string" ? response.chosen_model : candidates[0];
	if (!chosen) throw new Error("Copilot Auto router did not choose a model");

	state.chosenModel = chosen;
	const bucket = response.reasoning_bucket;
	state.reasoningBucket = bucket === "low" || bucket === "medium" || bucket === "high" ? bucket : undefined;
}
