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
	ANTIGRAVITY_ENDPOINT,
	ANTIGRAVITY_REDIRECT_URI,
	ANTIGRAVITY_SCOPES,
	TOKEN_USER_AGENT,
} from "./constants.ts";
import { ANTIGRAVITY_USER_AGENT } from "./fingerprint.ts";
import { fetchWithAgyCliTransport } from "./transport.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 15_000;

function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: number | undefined): number {
	const seconds = typeof expiresInSeconds === "number" && expiresInSeconds > 0 ? expiresInSeconds : 3600;
	return requestTimeMs + seconds * 1000;
}

function decodeVerifier(state: string): string {
	const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { verifier?: unknown };
	if (typeof parsed.verifier !== "string") throw new Error("Missing PKCE verifier in state");
	return parsed.verifier;
}

export function authorizeAntigravity(): string {
	const verifier = randomBytes(32).toString("base64url");
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
	url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
	url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", Buffer.from(JSON.stringify({ verifier }), "utf8").toString("base64url"));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return url.toString();
}

export async function refreshAntigravityToken(refreshToken: string): Promise<OAuthCredentials> {
	const startTime = Date.now();
	const response = await fetchWithAgyCliTransport(
		TOKEN_ENDPOINT,
		{
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
		},
		{ timeoutMs: TOKEN_TIMEOUT_MS },
	);
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

async function loadCodeAssistProject(accessToken: string): Promise<string> {
	const response = await fetchWithAgyCliTransport(
		`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": ANTIGRAVITY_USER_AGENT,
			},
			body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
		},
		{ timeoutMs: 10_000 },
	);
	if (!response.ok) {
		throw new Error(`Antigravity loadCodeAssist failed: HTTP ${response.status} ${await response.text()}`);
	}
	const payload = (await response.json()) as { cloudaicompanionProject?: string | { id?: string } };
	const project = payload.cloudaicompanionProject;
	return (typeof project === "string" ? project : project?.id) || ANTIGRAVITY_DEFAULT_PROJECT_ID;
}

export async function exchangeAntigravity(code: string, state: string): Promise<OAuthCredentials> {
	const startTime = Date.now();
	const response = await fetchWithAgyCliTransport(
		TOKEN_ENDPOINT,
		{
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
				code_verifier: decodeVerifier(state),
			}),
		},
		{ timeoutMs: TOKEN_TIMEOUT_MS },
	);
	if (!response.ok) {
		throw new Error(`Antigravity OAuth exchange failed: ${await response.text()}`);
	}
	const payload = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
	if (!payload.refresh_token) throw new Error("Antigravity OAuth exchange failed: missing refresh token in response");
	const project = await loadCodeAssistProject(payload.access_token);
	return {
		refresh: `${payload.refresh_token}|${project}`,
		access: payload.access_token,
		expires: calculateTokenExpiry(startTime, payload.expires_in),
	};
}
