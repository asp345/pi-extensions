import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";

interface OpenAiAuthCredentials {
	accessToken: string;
	accountId?: string;
}

function readStoredOAuthCredential(): { access: string; accountId?: string } | undefined {
	const credential = readStoredCredential(PROVIDER_ID);
	if (credential?.type !== "oauth") return undefined;
	const accountId = typeof credential.accountId === "string" && credential.accountId ? credential.accountId : undefined;
	return { access: credential.access, accountId };
}

/** Prefer the auto-refreshed OAuth token from pi's model registry, falling back to the stored credential. */
export async function resolveOpenAiAuth(ctx: ExtensionContext): Promise<OpenAiAuthCredentials | null> {
	let accessToken: string | undefined;
	try {
		const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
		const headerAuth = resolved?.auth.headers?.Authorization;
		accessToken =
			resolved?.auth.apiKey ?? (typeof headerAuth === "string" ? headerAuth.replace(/^Bearer\s+/i, "") : undefined);
	} catch {
		accessToken = undefined;
	}

	const stored = readStoredOAuthCredential();
	const token = accessToken ?? stored?.access;
	if (!token) return null;
	return { accessToken: token, accountId: stored?.accountId };
}
