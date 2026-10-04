import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	ANTIGRAVITY_CLIENT_ID,
	ANTIGRAVITY_CLIENT_SECRET,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
	ANTIGRAVITY_ENDPOINT,
	ANTIGRAVITY_REDIRECT_URI,
	ANTIGRAVITY_SCOPES,
	ANTIGRAVITY_USER_AGENT,
	TOKEN_USER_AGENT,
} from "./constants.ts";
import { fetchWithAgyCliTransport } from "./transport.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 15_000;

type Authorization = { code: string; state: string };
type TokenPayload = { access_token: string; refresh_token?: string; expires_in?: number };

function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: number | undefined): number {
	const seconds = typeof expiresInSeconds === "number" && expiresInSeconds > 0 ? expiresInSeconds : 3600;
	return requestTimeMs + seconds * 1000;
}

function decodeVerifier(state: string): string {
	const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { verifier?: unknown };
	if (typeof parsed.verifier !== "string") throw new Error("Missing PKCE verifier in state");
	return parsed.verifier;
}

function authorizationUrl(): string {
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

function parseAuthorization(input: string, fallbackState: string): Authorization | undefined {
	let code = input.trim();
	let state = fallbackState;
	try {
		const url = new URL(code);
		code = url.searchParams.get("code") ?? code;
		state = url.searchParams.get("state") ?? state;
	} catch {}
	return code ? { code, state } : undefined;
}

async function callbackServer(expectedState: string, signal?: AbortSignal) {
	const redirect = new URL(ANTIGRAVITY_REDIRECT_URI);
	const server = createServer();
	let settle!: (value?: Authorization) => void;
	const result = new Promise<Authorization | undefined>((resolve) => {
		settle = resolve;
	});
	const abort = () => settle();
	const timeout = setTimeout(abort, 5 * 60_000);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	server.on("request", (request, response) => {
		const url = new URL(request.url ?? "/", redirect);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (url.pathname !== redirect.pathname || !code || state !== expectedState) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Invalid Antigravity authorization callback.");
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(
			"<!doctype html><title>Authorization complete</title><h1>Authorization complete</h1><p>You can return to Pi.</p>",
		);
		settle({ code, state });
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(Number(redirect.port), redirect.hostname, resolve);
		});
	} catch (error) {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		server.close();
		throw error;
	}
	return {
		result,
		close: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			settle();
			server.closeAllConnections();
			server.close();
		},
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

async function exchangeCode({ code, state }: Authorization): Promise<OAuthCredentials> {
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
	const payload = (await response.json()) as TokenPayload;
	if (!payload.refresh_token) throw new Error("Antigravity OAuth exchange failed: missing refresh token in response");
	const project = await loadCodeAssistProject(payload.access_token);
	return {
		refresh: `${payload.refresh_token}|${project}`,
		access: payload.access_token,
		expires: calculateTokenExpiry(startTime, payload.expires_in),
	};
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const url = authorizationUrl();
	const expectedState = new URL(url).searchParams.get("state") ?? "";
	const callback = await callbackServer(expectedState, callbacks.signal);
	callbacks.onAuth({ url, instructions: "Complete login in your browser, or paste the final callback URL." });
	let result: Authorization | undefined;
	try {
		result = callbacks.onManualCodeInput
			? await Promise.race([
					callback.result,
					callbacks.onManualCodeInput().then((input) => parseAuthorization(input, expectedState)),
				])
			: await callback.result;
	} finally {
		callback.close();
	}
	if (callbacks.signal?.aborted) throw new Error("Antigravity OAuth login aborted.");
	if (!result) throw new Error("Missing Antigravity authorization code.");
	if (result.state !== expectedState) throw new Error("Antigravity OAuth state mismatch.");
	return exchangeCode(result);
}

export async function refreshOAuth(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const [refreshToken, project = ""] = credentials.refresh.split("|");
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
	const payload = (await response.json()) as TokenPayload;
	return {
		refresh: `${payload.refresh_token ?? refreshToken}|${project}`,
		access: payload.access_token,
		expires: calculateTokenExpiry(startTime, payload.expires_in),
	};
}
