/**
 * Antigravity OAuth: PKCE authorization-code flow against Google accounts,
 * token refresh, and the v1internal:loadCodeAssist project bootstrap.
 * All calls use the agy CLI transport so the wire identity stays uniform.
 */
import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
	ANTIGRAVITY_CLIENT_ID,
	ANTIGRAVITY_CLIENT_SECRET,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
	ANTIGRAVITY_ENDPOINT_FALLBACKS,
	ANTIGRAVITY_REDIRECT_URI,
	ANTIGRAVITY_SCOPES,
	TOKEN_USER_AGENT,
} from "./constants.ts";
import { buildAntigravityHarnessUserAgent } from "./fingerprint.ts";
import { fetchWithAgyCliTransport } from "./transport.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const ACTIVE_FETCH_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;

export interface AntigravityAuthorization {
	url: string;
	verifier: string;
	projectId: string;
}

export type ExchangeResult =
	| { type: "success"; refresh: string; access: string; expires: number; email?: string; projectId: string }
	| { type: "failed"; error: string };

/** Stream-safe fetch: aborts only while headers are pending, never mid-body. */
async function fetchWithActiveTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = ACTIVE_FETCH_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(timeoutMs);
	const onTimeout = () => controller.abort(timeout.reason);
	if (timeout.aborted) onTimeout();
	else timeout.addEventListener("abort", onTimeout, { once: true });
	try {
		return await fetch(url, {
			...init,
			signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
		});
	} finally {
		timeout.removeEventListener("abort", onTimeout);
	}
}

function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: number | undefined): number {
	const seconds = typeof expiresInSeconds === "number" && expiresInSeconds > 0 ? expiresInSeconds : 3600;
	return requestTimeMs + seconds * 1000;
}

function accessTokenExpired(credentials: OAuthCredentials): boolean {
	if (!credentials.access || typeof credentials.expires !== "number") return true;
	return credentials.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

/** Splits "refreshToken|projectId|managedProjectId" packed by exchangeProjectContext. */
export function parseRefreshParts(refresh: string): {
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
} {
	const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
	return {
		refreshToken,
		projectId: projectId || undefined,
		managedProjectId: managedProjectId || undefined,
	};
}

export function formatRefreshParts(parts: {
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
}): string {
	const base = `${parts.refreshToken}|${parts.projectId ?? ""}`;
	return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

export { accessTokenExpired };

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function encodeState(payload: { verifier: string; projectId: string }): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state: string): { verifier: string; projectId: string } {
	const json = Buffer.from(state, "base64url").toString("utf8");
	const parsed = JSON.parse(json) as { verifier?: unknown; projectId?: unknown };
	if (typeof parsed.verifier !== "string") throw new Error("Missing PKCE verifier in state");
	return { verifier: parsed.verifier, projectId: typeof parsed.projectId === "string" ? parsed.projectId : "" };
}

export async function authorizeAntigravity(projectId = ""): Promise<AntigravityAuthorization> {
	const pkce = await generatePKCE();
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
	url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", encodeState({ verifier: pkce.verifier, projectId }));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return { url: url.toString(), verifier: pkce.verifier, projectId };
}

export async function refreshAntigravityToken(refreshToken: string): Promise<OAuthCredentials> {
	const startTime = Date.now();
	const response = await fetchWithActiveTimeout(TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": TOKEN_USER_AGENT,
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
		}),
	});
	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`Antigravity token refresh failed (${response.status} ${response.statusText})${errorText ? ` - ${errorText}` : ""}`,
		);
	}
	const payload = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
	return {
		access: payload.access_token,
		refresh: payload.refresh_token ?? refreshToken,
		expires: calculateTokenExpiry(startTime, payload.expires_in),
	};
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
}

function extractProjectId(payload: LoadCodeAssistPayload): string | undefined {
	if (typeof payload.cloudaicompanionProject === "string") return payload.cloudaicompanionProject;
	const id = payload.cloudaicompanionProject?.id;
	return typeof id === "string" && id ? id : undefined;
}

async function loadCodeAssist(accessToken: string, timeoutMs = 10_000): Promise<string | undefined> {
	for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
		try {
			const response = await fetchWithAgyCliTransport(
				`${endpoint}/v1internal:loadCodeAssist`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
						"User-Agent": buildAntigravityHarnessUserAgent(),
					},
					body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
				},
				{ timeoutMs },
			);
			if (!response.ok) continue;
			const projectId = extractProjectId((await response.json()) as LoadCodeAssistPayload);
			if (projectId) return projectId;
		} catch {
			// try the next endpoint
		}
	}
	return undefined;
}

export async function exchangeAntigravity(code: string, state: string): Promise<ExchangeResult> {
	try {
		const { verifier, projectId } = decodeState(state);
		const startTime = Date.now();
		const tokenResponse = await fetchWithActiveTimeout(TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
				Accept: "*/*",
				"User-Agent": TOKEN_USER_AGENT,
			},
			body: new URLSearchParams({
				client_id: ANTIGRAVITY_CLIENT_ID,
				client_secret: ANTIGRAVITY_CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
				redirect_uri: ANTIGRAVITY_REDIRECT_URI,
				code_verifier: verifier,
			}),
		});
		if (!tokenResponse.ok) {
			return { type: "failed", error: await tokenResponse.text() };
		}
		const tokenPayload = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!tokenPayload.refresh_token) {
			return { type: "failed", error: "Missing refresh token in response" };
		}
		let effectiveProjectId = projectId;
		if (!effectiveProjectId) effectiveProjectId = (await loadCodeAssist(tokenPayload.access_token)) ?? "";
		return {
			type: "success",
			refresh: `${tokenPayload.refresh_token}|${effectiveProjectId}`,
			access: tokenPayload.access_token,
			expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
			projectId: effectiveProjectId,
		};
	} catch (error) {
		return { type: "failed", error: error instanceof Error ? error.message : "Unknown error" };
	}
}

/**
 * Resolves the effective project id for requests. Uses the managed project
 * when present, falls back to the packed project id, then to the hardcoded
 * default (workspace/business accounts without a cloudaicompanion project).
 */
export async function ensureProjectContext(credentials: OAuthCredentials): Promise<{
	auth: OAuthCredentials;
	effectiveProjectId: string;
}> {
	const parts = parseRefreshParts(credentials.refresh);
	if (parts.managedProjectId) {
		return { auth: credentials, effectiveProjectId: parts.managedProjectId };
	}
	if (parts.projectId) {
		return { auth: credentials, effectiveProjectId: parts.projectId };
	}
	const managedProjectId = await loadCodeAssist(credentials.access);
	if (managedProjectId) {
		const updated: OAuthCredentials = {
			...credentials,
			refresh: formatRefreshParts({
				refreshToken: parts.refreshToken,
				projectId: parts.projectId,
				managedProjectId,
			}),
		};
		return { auth: updated, effectiveProjectId: managedProjectId };
	}
	return { auth: credentials, effectiveProjectId: ANTIGRAVITY_DEFAULT_PROJECT_ID };
}
