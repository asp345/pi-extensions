/**
 * Cline credential file traversal.
 *
 * @module clinepass-auth
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./utils.js";

/**
 * Default auth file paths checked in order.
 *
 * 1. ~/.cline/data/settings/providers.json — Cline CLI credentials
 * 2. ~/.pi/agent/auth.json — pi OAuth credentials
 */
export function defaultAuthPaths(home: string): string[] {
	return [join(home, ".cline", "data", "settings", "providers.json"), join(home, ".pi", "agent", "auth.json")];
}

export interface AuthKeyOptions {
	env?: Record<string, string | undefined>;
	authPaths?: readonly string[];
	homeDir?: () => string;
	readFile?: (path: string) => string;
	fileExists?: (path: string) => boolean;
}

/**
 * Iterate auth files, parse JSON records, and return the first extracted value.
 *
 * @param options Auth file I/O options.
 * @param extract Extracts a value from each parsed record.
 */
export function walkAuthPaths<T>(
	options: AuthKeyOptions,
	extract: (parsed: Record<string, unknown>) => T | undefined,
): T | undefined {
	const home = options.homeDir?.() ?? homedir();
	const authPaths = options.authPaths ?? defaultAuthPaths(home);
	const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
	const fileExists = options.fileExists ?? ((p: string) => existsSync(p));

	for (const authPath of authPaths) {
		try {
			if (!fileExists(authPath)) continue;
			const parsed: unknown = JSON.parse(readFile(authPath));
			if (!isRecord(parsed)) continue;

			const result = extract(parsed);
			if (result !== undefined) return result;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("ENOENT") && !msg.includes("not found")) {
				console.warn(`[clinepass] Warning: failed to read auth file ${authPath}: ${msg}`);
			}
		}
	}
	return undefined;
}
