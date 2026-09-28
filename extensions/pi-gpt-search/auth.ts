import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";

interface OpenAiAuthCredentials {
	accessToken: string;
	accountId?: string;
}

export async function resolveOpenAiAuth(ctx: ExtensionContext): Promise<OpenAiAuthCredentials | null> {
	const accessToken = (await ctx.modelRegistry.getProviderAuth(PROVIDER_ID))?.auth.apiKey;
	if (!accessToken) return null;
	const credential = readStoredCredential(PROVIDER_ID);
	const accountId =
		credential?.type === "oauth" && typeof credential.accountId === "string" ? credential.accountId : "";
	return { accessToken, accountId: accountId || undefined };
}
