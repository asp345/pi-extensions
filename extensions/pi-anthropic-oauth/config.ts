import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "@asp345/pi-shared/format.ts";
import { isRecord } from "@asp345/pi-shared/json.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AnthropicOAuthConfig {
	cacheTtl: "5m" | "1h";
}

const DEFAULT_CONFIG: AnthropicOAuthConfig = {
	cacheTtl: "5m",
};

export function parseAnthropicOAuthConfig(value: unknown, source: string): Partial<AnthropicOAuthConfig> {
	if (!isRecord(value)) throw new Error(`${source} must contain a JSON object.`);
	const unsupported = Object.keys(value).filter((key) => key !== "cacheTtl");
	if (unsupported.length > 0) throw new Error(`${source}: unsupported setting ${unsupported.join(", ")}.`);

	const config: Partial<AnthropicOAuthConfig> = {};
	if (value.cacheTtl !== undefined) {
		if (value.cacheTtl !== "5m" && value.cacheTtl !== "1h") {
			throw new Error(`${source}: cacheTtl must be "5m" or "1h".`);
		}
		config.cacheTtl = value.cacheTtl;
	}
	return config;
}

function readConfig(path: string): Partial<AnthropicOAuthConfig> {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${errorMessage(error)}`);
	}
	return parseAnthropicOAuthConfig(value, path);
}

export function loadAnthropicOAuthConfig(cwd: string, projectTrusted: boolean): AnthropicOAuthConfig {
	const globalConfig = readConfig(join(getAgentDir(), "pi-anthropic-oauth.json"));
	const projectConfig = projectTrusted ? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-anthropic-oauth.json")) : {};
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
