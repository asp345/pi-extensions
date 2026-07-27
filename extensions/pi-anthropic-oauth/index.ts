import { createServer } from "node:http";
import {
	anthropicMessagesApi,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

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
	let error = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (response.ok) return response;
		error = `${response.status} ${await response.text()}`;
		if (
			response.headers.get("x-should-retry") === "false" ||
			(response.status !== 429 && response.status < 500) ||
			attempt === 2
		)
			break;
		const retryAfter = Number(response.headers.get("retry-after"));
		await new Promise((resolve) =>
			setTimeout(resolve, retryAfter > 0 ? Math.min(retryAfter * 1_000, 30_000) : 5_000 * 2 ** attempt),
		);
	}
	throw new OAuthRequestError(Number(error.split(" ", 1)[0]) || 0, `Anthropic OAuth request failed: ${error}`);
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await createPkce();
	const state = crypto.randomUUID().replace(/-/g, "");
	let redirect = REMOTE_REDIRECT;
	let authorization: Partial<Authorization> | undefined;
	let server: Awaited<ReturnType<typeof callbackServer>> | undefined;

	try {
		server = await callbackServer(state);
		redirect = LOCAL_REDIRECT;
		callbacks.onAuth({
			url: authorizationUrl(challenge, state, redirect),
			instructions: "Complete login in your browser, or paste the final redirect URL.",
		});
		const result = callbacks.onManualCodeInput
			? await Promise.race([server.result, callbacks.onManualCodeInput().then(parseAuthorization)])
			: await server.result;
		authorization = result;
	} catch (error) {
		if (server) throw error;
	} finally {
		server?.close();
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

	const response = await tokenRequest(
		{
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: authorization.code,
			state: authorization.state ?? state,
			redirect_uri: redirect,
			code_verifier: verifier,
		},
		callbacks.signal,
	);
	const token = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};
	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1_000 - 5 * 60_000,
	};
}

async function refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	try {
		const response = await tokenRequest({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		});
		const token = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};
		return {
			access: token.access_token,
			refresh: token.refresh_token || credentials.refresh,
			expires: Date.now() + token.expires_in * 1_000 - 5 * 60_000,
		};
	} catch (error) {
		const transient = error instanceof OAuthRequestError && (error.status === 429 || error.status >= 500);
		if (transient && credentials.expires > Date.now()) {
			return { ...credentials, expires: Date.now() + 30_000 };
		}
		throw error;
	}
}

function rewriteSystemPrompt(text: string): string {
	return text
		.toWellFormed()
		.split(/\n\n+/)
		.filter((paragraph) => {
			const lower = paragraph.toLowerCase();
			return !lower.includes("you are pi") && !lower.includes("pi-coding-agent") && !lower.includes("badlogic/pi-mono");
		})
		.join("\n\n")
		.replace(/(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])/g, "Claude Code")
		.trim();
}

function stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return anthropicMessagesApi().streamSimple(
		model as Model<"anthropic-messages">,
		{
			...context,
			systemPrompt: context.systemPrompt ? rewriteSystemPrompt(context.systemPrompt) : context.systemPrompt,
		},
		options,
	);
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
		} as unknown as ProviderConfig["oauth"],
		streamSimple: stream,
	});
}
