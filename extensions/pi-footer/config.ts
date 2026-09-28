import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../shared/json.ts";

const CONTEXT_STYLES = ["pct-window", "used-window", "pct", "used", "bar"] as const;
const SPEED_STYLES = ["t/s", "tok/s", "T/s", "liveAt"] as const;
export type ContextStyle = (typeof CONTEXT_STYLES)[number];
export type SpeedStyle = (typeof SPEED_STYLES)[number];
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

export interface PiFooterConfig {
	ttl: number;
	display: DisplayConfig;
}

const CONFIG_FILE = join(getAgentDir(), "pi-footer.json");

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

function parseDisplay(value: unknown): DisplayConfig {
	const source = isRecord(value) ? value : {};
	const savedItems = isRecord(source.items) ? source.items : {};
	const items = { ...DEFAULT_DISPLAY_CONFIG.items };
	for (const key of Object.keys(items) as DisplayKey[]) {
		if (typeof savedItems[key] === "boolean") items[key] = savedItems[key];
	}
	const contextStyle =
		CONTEXT_STYLES.find((style) => style === source.contextStyle) ?? DEFAULT_DISPLAY_CONFIG.contextStyle;
	const speedStyle = SPEED_STYLES.find((style) => style === source.speedStyle) ?? DEFAULT_DISPLAY_CONFIG.speedStyle;
	return { items, contextStyle, speedStyle };
}

function parseConfig(value: unknown): PiFooterConfig {
	const source = isRecord(value) ? value : {};
	const ttl = typeof source.ttl === "number" && source.ttl >= 10 ? source.ttl : 300;
	return {
		ttl,
		display: parseDisplay(source.display),
	};
}

export class FooterConfigStore {
	config = parseConfig({});

	async load(): Promise<void> {
		try {
			this.config = parseConfig(JSON.parse(await readFile(CONFIG_FILE, "utf-8")));
		} catch {
			this.config = parseConfig({});
		}
	}

	async save(config: PiFooterConfig): Promise<void> {
		this.config = config;
		await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	}
}
