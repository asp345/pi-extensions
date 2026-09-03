import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CustomProvidersFile } from "./types.ts";

export const CUSTOM_PROVIDERS_FILE = join(getAgentDir(), "custom-providers.json");
export const MODELS_STORE_FILE = join(getAgentDir(), "models-store.json");

export async function readCustomProvidersFile(path = CUSTOM_PROVIDERS_FILE): Promise<CustomProvidersFile> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw error;
	}

	const value = JSON.parse(text) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("custom-providers.json must contain an object");
	}
	const root = value as { providers?: unknown };
	if (root.providers === undefined) root.providers = {};
	if (typeof root.providers !== "object" || root.providers === null || Array.isArray(root.providers)) {
		throw new Error("custom-providers.json providers must contain an object");
	}
	return value as CustomProvidersFile;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}

export async function writeCustomProvidersFile(data: CustomProvidersFile, path = CUSTOM_PROVIDERS_FILE): Promise<void> {
	await writeJsonAtomic(path, data);
}

/** Removes cached catalogs only for providers removed through this extension. */
export async function removeModelsStoreProviders(
	providerIds: ReadonlySet<string>,
	path = MODELS_STORE_FILE,
): Promise<string[]> {
	if (providerIds.size === 0) return [];
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const store = value as Record<string, unknown>;
	const removed = [...providerIds].filter((providerId) => providerId in store);
	if (removed.length === 0) return [];
	for (const providerId of removed) delete store[providerId];
	await writeJsonAtomic(path, store);
	return removed;
}
