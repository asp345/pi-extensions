import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ResolvedCredential } from "./types.ts";

interface StoredOAuthCredential {
	type: string;
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
	[key: string]: unknown;
}

type StoredCredential = StoredOAuthCredential | { type: string; key?: string; [key: string]: unknown };

async function readStoredCredential(providerId: string): Promise<StoredOAuthCredential | undefined> {
	try {
		const raw = await readFile(join(getAgentDir(), "auth.json"), "utf8");
		const all = JSON.parse(raw) as Record<string, StoredCredential>;
		const entry = all[providerId];
		if (!entry || entry.type !== "oauth" || typeof entry.access !== "string" || !entry.access) return undefined;
		return entry as StoredOAuthCredential;
	} catch {
		return undefined;
	}
}

/**
 * Extract the Antigravity project id. The pi-antigravity-auth extension encodes
 * it after a `|` separator inside the stored refresh token.
 */
function projectFromRefresh(refresh: string | undefined): string | undefined {
	if (!refresh) return undefined;
	const separator = refresh.indexOf("|");
	if (separator === -1) return undefined;
	const tail = refresh.slice(separator + 1);
	return tail || undefined;
}

/**
 * Resolve a credential for a provider, preferring `ctx.modelRegistry.getProviderAuth`
 * (which returns a fresh, auto-refreshed OAuth token) and falling back to the
 * stored auth.json entry when the provider is unknown to the registry (for example
 * an extension-registered provider that does not expose auth resolution).
 */
export async function resolveCredential(
	providerId: string,
	ctx: ExtensionContext,
): Promise<ResolvedCredential | undefined> {
	const registry = ctx.modelRegistry as
		| {
				getProviderAuth?: (
					provider: string,
				) => Promise<{ auth: { apiKey?: string; headers?: Record<string, string | null> } } | undefined>;
		  }
		| undefined;

	const resolved = await registry?.getProviderAuth?.(providerId);
	const headerAuth = resolved?.auth.headers?.["Authorization"];
	const accessToken =
		resolved?.auth.apiKey ?? (typeof headerAuth === "string" ? headerAuth.replace(/^Bearer\s+/i, "") : undefined);

	const stored = await readStoredCredential(providerId);

	if (!accessToken && !stored?.access) return undefined;

	const token = accessToken ?? stored?.access ?? "";
	const credential: ResolvedCredential = { accessToken: token };

	// account/project metadata is not surfaced through getProviderAuth; read it
	// from the stored credential.
	if (stored?.accountId) credential.accountId = stored.accountId;
	if (providerId === "google-antigravity" || providerId === "antigravity") {
		const project = projectFromRefresh(stored?.refresh);
		if (project) credential.projectId = project;
	}

	return credential;
}
