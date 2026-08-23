import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CodexCompactionConfig {
	autoCompact: boolean;
	thresholdRatio: number;
}

const DEFAULT_CODEX_CONFIG: CodexCompactionConfig = {
	autoCompact: true,
	thresholdRatio: 0.9,
};

function readConfig(path: string): Partial<CodexCompactionConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			...(typeof parsed.autoCompact === "boolean" ? { autoCompact: parsed.autoCompact } : {}),
			...(typeof parsed.thresholdRatio === "number" && parsed.thresholdRatio > 0 && parsed.thresholdRatio < 1
				? { thresholdRatio: parsed.thresholdRatio }
				: {}),
		};
	} catch {
		return {};
	}
}

export function loadCodexConfig(cwd: string, projectTrusted: boolean): CodexCompactionConfig {
	const globalConfig = readConfig(join(getAgentDir(), "pi-compaction.json"));
	const projectConfig = projectTrusted ? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-compaction.json")) : {};
	return { ...DEFAULT_CODEX_CONFIG, ...globalConfig, ...projectConfig };
}
