import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAnthropicOAuthConfig } from "./config.ts";

export function isOAuthKey(apiKey: string | undefined): boolean {
	return !apiKey || apiKey.includes("sk-ant-oat");
}

export async function usesLongOAuthCache(ctx: ExtensionContext): Promise<boolean> {
	if (ctx.model?.provider !== "anthropic") return false;
	if (loadAnthropicOAuthConfig(ctx.cwd, ctx.isProjectTrusted()).cacheTtl !== "1h") return false;
	return isOAuthKey(await ctx.modelRegistry.getApiKeyForProvider("anthropic"));
}
