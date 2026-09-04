import { createHash } from "node:crypto";
import { AgyRequestSessionStore } from "./agy/index.ts";

export const requestSessions = new AgyRequestSessionStore("");
export const refreshByAccessToken = new Map<string, string>();

export function requestSessionKey(conversation: string, credential: string): string {
	const scope = createHash("sha256").update(credential).digest("hex").slice(0, 16);
	return `${scope}:${conversation}`;
}

export function rememberRefresh(access: string, refresh: string): void {
	if (!access) return;
	refreshByAccessToken.delete(access);
	while (refreshByAccessToken.size >= 4) {
		const oldest = refreshByAccessToken.keys().next().value;
		if (!oldest) break;
		refreshByAccessToken.delete(oldest);
	}
	refreshByAccessToken.set(access, refresh);
}
