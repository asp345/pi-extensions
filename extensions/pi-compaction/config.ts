import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./protocol.ts";

export interface CompactionConfig {
	nativeCodex: boolean;
	nativeClaude: boolean;
}

const DEFAULT_CONFIG: CompactionConfig = {
	nativeCodex: true,
	nativeClaude: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCompactionConfig(value: unknown, source: string): Partial<CompactionConfig> {
	if (!isRecord(value)) throw new Error(`${source} must contain a JSON object.`);
	const unsupported = Object.keys(value).filter((key) => key !== "nativeCodex" && key !== "nativeClaude");
	if (unsupported.length > 0) throw new Error(`${source}: unsupported setting ${unsupported.join(", ")}.`);

	const config: Partial<CompactionConfig> = {};
	if (value.nativeCodex !== undefined) {
		if (typeof value.nativeCodex !== "boolean") throw new Error(`${source}: nativeCodex must be a boolean.`);
		config.nativeCodex = value.nativeCodex;
	}
	if (value.nativeClaude !== undefined) {
		if (typeof value.nativeClaude !== "boolean") throw new Error(`${source}: nativeClaude must be a boolean.`);
		config.nativeClaude = value.nativeClaude;
	}
	return config;
}

function readConfig(path: string): Partial<CompactionConfig> {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${errorMessage(error)}`);
	}
	return parseCompactionConfig(value, path);
}

export function loadCompactionConfig(cwd: string, projectTrusted: boolean): CompactionConfig {
	const globalConfig = readConfig(join(getAgentDir(), "pi-compaction.json"));
	const projectConfig = projectTrusted ? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-compaction.json")) : {};
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
