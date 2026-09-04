import { createServer } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	ANTIGRAVITY_REDIRECT_URI,
	authorizeAntigravity,
	exchangeAntigravity,
	refreshAntigravityToken,
} from "./agy/index.ts";

export type Authorization = { code: string; state: string };

export function parseAuthorization(input: string, fallbackState: string): Authorization | undefined {
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

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const authorization = await authorizeAntigravity();
	const expectedState = new URL(authorization.url).searchParams.get("state") ?? "";
	let callback: Awaited<ReturnType<typeof callbackServer>> | undefined;
	let result: Authorization | undefined;
	try {
		callback = await callbackServer(expectedState, callbacks.signal);
	} catch {}

	callbacks.onAuth({
		url: authorization.url,
		instructions: callback
			? "Complete login in your browser, or paste the final callback URL."
			: "Paste the final callback URL after completing login.",
	});
	if (callback) {
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
	}
	if (callbacks.signal?.aborted) throw new Error("Antigravity OAuth login aborted.");
	result ??= parseAuthorization(
		await callbacks.onPrompt({ message: "Paste the Antigravity OAuth callback URL or code:" }),
		expectedState,
	);
	if (!result) throw new Error("Missing Antigravity authorization code.");
	if (result.state !== expectedState) throw new Error("Antigravity OAuth state mismatch.");

	const exchanged = await exchangeAntigravity(result.code, result.state);
	if (exchanged.type !== "success") {
		throw new Error(`Antigravity OAuth exchange failed: ${exchanged.error}`);
	}
	return {
		refresh: exchanged.refresh,
		access: exchanged.access,
		expires: exchanged.expires,
	};
}

export async function refreshOAuth(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const separator = credentials.refresh.indexOf("|");
	const refreshToken = separator === -1 ? credentials.refresh : credentials.refresh.slice(0, separator);
	const project = separator === -1 ? "" : credentials.refresh.slice(separator);
	const result = await refreshAntigravityToken(refreshToken);
	return {
		refresh: `${result.refresh}${project}`,
		access: result.access,
		expires: result.expires,
	};
}
