import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PiFffConfig {
	defaultExcludes: string[];
}

export const DEFAULT_CONFIG: PiFffConfig = {
	defaultExcludes: [
		".direnv/",
		".envrc",
		".envrc/",
		".claude/",
		".codex",
		".codex/",
		".antigravitycli",
		".antigravitycli/",
		".worktrees/",
		".pi/",
	],
};

const CONFIG_FILE = join(getAgentDir(), "pi-fff.json");

function parseConfig(value: unknown): PiFffConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_CONFIG;
	const excludes = (value as Record<string, unknown>).defaultExcludes;
	if (!Array.isArray(excludes)) return DEFAULT_CONFIG;
	const defaultExcludes = [
		...new Set(
			excludes
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
	return { defaultExcludes };
}

export function loadConfig(): PiFffConfig {
	try {
		if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
		return parseConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as unknown);
	} catch {
		return DEFAULT_CONFIG;
	}
}
