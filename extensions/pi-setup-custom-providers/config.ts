import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelsFile } from "./types.ts";

export const MODELS_FILE = join(getAgentDir(), "models.json");
export const MODELS_STORE_FILE = join(getAgentDir(), "models-store.json");

export async function readModelsFile(path = MODELS_FILE): Promise<ModelsFile> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw error;
	}

	const value = JSON.parse(text) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("models.json must contain an object");
	}
	const root = value as { providers?: unknown };
	if (root.providers === undefined) root.providers = {};
	if (typeof root.providers !== "object" || root.providers === null || Array.isArray(root.providers)) {
		throw new Error("models.json providers must contain an object");
	}
	return value as ModelsFile;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}

export async function writeModelsFile(data: ModelsFile, path = MODELS_FILE): Promise<void> {
	await writeJsonAtomic(path, data);
}

/**
 * Pi never deletes a models-store entry, even when the provider is
 * unregistered, so entries authored for removed custom providers linger
 * indefinitely. They stay readable offline and outrank the user's
 * configuration on the next merge, which is the failure that surfaced
 * earlier. Entries for pi's built-in providers and for providers still
 * present in models.json are left untouched; only entries that no longer have
 * a live configuration are dropped. The removed ids are returned so callers
 * can report what was pruned.
 */
export async function pruneModelsStore(
	liveProviders: ReadonlySet<string>,
	path = MODELS_STORE_FILE,
): Promise<string[]> {
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

	const orphans = Object.keys(store).filter((providerId) => !liveProviders.has(providerId));
	if (orphans.length === 0) return [];
	for (const providerId of orphans) delete store[providerId];
	await writeJsonAtomic(path, store);
	return orphans;
}
