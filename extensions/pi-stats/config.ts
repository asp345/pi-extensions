import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ContextStyle = "pct-window" | "used-window" | "pct" | "used" | "bar";
export type SpeedStyle = "t/s" | "tok/s" | "T/s" | "liveAt";
export type DisplayKey =
	| "input"
	| "output"
	| "totalTokens"
	| "cost"
	| "cacheHit"
	| "speed"
	| "context"
	| "quota5h"
	| "quotaDay"
	| "quotaWeek"
	| "quotaMonth"
	| "quotaBalance"
	| "quotaClock";

export interface DisplayConfig {
	items: Record<DisplayKey, boolean>;
	contextStyle: ContextStyle;
	speedStyle: SpeedStyle;
}

export interface PiStatsConfig {
	providerPlans: Record<string, string | null>;
	teamCredential?: { organization: string; project: string };
	ttl: number;
	display: DisplayConfig;
}

const CONFIG_FILE = join(getAgentDir(), "pi-stats.json");
const LEGACY_DIR = join(getAgentDir(), "extensions", "pi-stats");
const LEGACY_TOKEN_CONFIG_FILE = join(LEGACY_DIR, "config.json");
const LEGACY_DISPLAY_CONFIG_FILE = join(LEGACY_DIR, "display-config.json");

export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
	items: {
		input: true,
		output: true,
		totalTokens: false,
		cost: true,
		cacheHit: true,
		speed: true,
		context: true,
		quota5h: true,
		quotaDay: true,
		quotaWeek: true,
		quotaMonth: true,
		quotaBalance: true,
		quotaClock: true,
	},
	contextStyle: "pct-window",
	speedStyle: "t/s",
};

export const DEFAULT_CONFIG: PiStatsConfig = {
	providerPlans: {},
	ttl: 60,
	display: DEFAULT_DISPLAY_CONFIG,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDisplay(value: unknown): DisplayConfig {
	const source = isRecord(value) ? value : {};
	const savedItems = isRecord(source.items) ? source.items : {};
	const items = { ...DEFAULT_DISPLAY_CONFIG.items };
	for (const key of Object.keys(items) as DisplayKey[]) {
		if (typeof savedItems[key] === "boolean") items[key] = savedItems[key];
	}
	const contextStyle = ["pct-window", "used-window", "pct", "used", "bar"].includes(String(source.contextStyle))
		? (source.contextStyle as ContextStyle)
		: DEFAULT_DISPLAY_CONFIG.contextStyle;
	const speedStyle = ["t/s", "tok/s", "T/s", "liveAt"].includes(String(source.speedStyle))
		? (source.speedStyle as SpeedStyle)
		: DEFAULT_DISPLAY_CONFIG.speedStyle;
	return { items, contextStyle, speedStyle };
}

function parseConfig(value: unknown, legacyDisplay?: unknown): PiStatsConfig {
	const source = isRecord(value) ? value : {};
	const providerPlans = isRecord(source.providerPlans)
		? Object.fromEntries(
				Object.entries(source.providerPlans).filter(
					(entry): entry is [string, string | null] => typeof entry[1] === "string" || entry[1] === null,
				),
			)
		: {};
	const team = isRecord(source.teamCredential) ? source.teamCredential : undefined;
	const teamCredential =
		typeof team?.organization === "string" && typeof team.project === "string"
			? { organization: team.organization, project: team.project }
			: undefined;
	const ttl = typeof source.ttl === "number" && source.ttl >= 10 ? source.ttl : DEFAULT_CONFIG.ttl;
	return {
		providerPlans,
		...(teamCredential ? { teamCredential } : {}),
		ttl,
		display: parseDisplay(source.display ?? legacyDisplay),
	};
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, "utf-8")) as unknown;
}

export async function loadConfig(): Promise<PiStatsConfig> {
	try {
		if (existsSync(CONFIG_FILE)) return parseConfig(await readJson(CONFIG_FILE));
		const legacyToken = existsSync(LEGACY_TOKEN_CONFIG_FILE) ? await readJson(LEGACY_TOKEN_CONFIG_FILE) : {};
		const legacyDisplay = existsSync(LEGACY_DISPLAY_CONFIG_FILE)
			? await readJson(LEGACY_DISPLAY_CONFIG_FILE)
			: undefined;
		const migrated = parseConfig(legacyToken, legacyDisplay);
		if (existsSync(LEGACY_TOKEN_CONFIG_FILE) || existsSync(LEGACY_DISPLAY_CONFIG_FILE)) {
			try {
				await saveConfig(migrated);
			} catch {
				// Keep the migrated values in memory when the new file cannot be written.
			}
		}
		return migrated;
	} catch {
		return {
			...DEFAULT_CONFIG,
			providerPlans: {},
			display: { ...DEFAULT_DISPLAY_CONFIG, items: { ...DEFAULT_DISPLAY_CONFIG.items } },
		};
	}
}

export async function saveConfig(config: PiStatsConfig): Promise<void> {
	await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
