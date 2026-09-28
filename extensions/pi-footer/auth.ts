import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { QuotaPlan } from "./quota.ts";
import type { ResolvedCredential } from "./types.ts";

interface StoredCredential {
	key?: string;
	access?: string;
	refresh?: string;
	accountId?: string;
}

async function readAuthFile(): Promise<Record<string, StoredCredential>> {
	try {
		return JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as Record<string, StoredCredential>;
	} catch {
		return {};
	}
}

export async function resolveCredential(
	plan: QuotaPlan,
	ctx: ExtensionContext,
): Promise<ResolvedCredential | undefined> {
	const envKey = plan.apiKeyEnv ? process.env[plan.apiKeyEnv] : undefined;
	if (envKey) return { accessToken: envKey };
	const stored = await readAuthFile();
	for (const providerId of plan.matchProviders) {
		const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
		const header = resolved?.auth.headers?.Authorization;
		const entry = stored[providerId];
		const accessToken = resolved?.auth.apiKey ?? header?.replace(/^Bearer\s+/i, "") ?? entry?.key ?? entry?.access;
		if (!accessToken) continue;
		return { accessToken, accountId: entry?.accountId, projectId: entry?.refresh?.match(/\|(.+)$/)?.[1] };
	}
	return undefined;
}
