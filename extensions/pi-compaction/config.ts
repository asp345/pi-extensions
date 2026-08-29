import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TextCompactionModel {
	provider: string;
	id: string;
}

export type TextCompactionMode = "prompt" | "native-materialize";

export interface CompactionConfig {
	nativeCodex: boolean;
	textMode: TextCompactionMode;
	textModel?: TextCompactionModel;
}

const DEFAULT_CONFIG: CompactionConfig = {
	nativeCodex: true,
	textMode: "prompt",
	textModel: { provider: "antigravity", id: "gemini-3.7-flash" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value.trim();
}

export function parseCompactionConfig(value: unknown, source: string): Partial<CompactionConfig> {
	if (!isRecord(value)) throw new Error(`${source} must contain a JSON object.`);
	const unsupported = Object.keys(value).filter(
		(key) => key !== "nativeCodex" && key !== "textMode" && key !== "textModel",
	);
	if (unsupported.length > 0) throw new Error(`${source}: unsupported setting ${unsupported.join(", ")}.`);

	const config: Partial<CompactionConfig> = {};
	if (value.nativeCodex !== undefined) {
		if (typeof value.nativeCodex !== "boolean") throw new Error(`${source}: nativeCodex must be a boolean.`);
		config.nativeCodex = value.nativeCodex;
	}
	if (value.textMode !== undefined) {
		if (value.textMode !== "prompt" && value.textMode !== "native-materialize") {
			throw new Error(`${source}: textMode must be "prompt" or "native-materialize".`);
		}
		config.textMode = value.textMode;
	}
	if (value.textModel !== undefined) {
		if (!isRecord(value.textModel)) throw new Error(`${source}: textModel must be an object.`);
		const unsupportedModel = Object.keys(value.textModel).filter((key) => key !== "provider" && key !== "id");
		if (unsupportedModel.length > 0) {
			throw new Error(`${source}: unsupported textModel setting ${unsupportedModel.join(", ")}.`);
		}
		config.textModel = {
			provider: nonEmptyString(value.textModel.provider, `${source}: textModel.provider`),
			id: nonEmptyString(value.textModel.id, `${source}: textModel.id`),
		};
	}
	return config;
}

function readConfig(path: string): Partial<CompactionConfig> {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${path}: ${message}`);
	}
	return parseCompactionConfig(value, path);
}

export function loadCompactionConfig(cwd: string, projectTrusted: boolean): CompactionConfig {
	const globalConfig = readConfig(join(getAgentDir(), "pi-compaction.json"));
	const projectConfig = projectTrusted ? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-compaction.json")) : {};
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
