import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isTier, type Tier } from "./tier.ts";

const CONTEXT_MODES = ["standard", "1m"] as const;
type ContextMode = (typeof CONTEXT_MODES)[number];

export interface OpenAISettings {
	contextMode: ContextMode;
	daybreak: boolean;
	serviceTier: Tier;
}

const STATE_FILE = join(getAgentDir(), "openai-models.json");
const DEFAULT_SETTINGS: OpenAISettings = { contextMode: "1m", daybreak: true, serviceTier: "default" };

export function isContextMode(value: string): value is ContextMode {
	return (CONTEXT_MODES as readonly string[]).includes(value);
}

export async function loadSettings(): Promise<OpenAISettings> {
	try {
		const value: unknown = JSON.parse(await readFile(STATE_FILE, "utf8"));
		const state = value as { contextMode?: unknown; daybreak?: unknown; serviceTier?: unknown };
		return {
			contextMode:
				typeof state.contextMode === "string" && isContextMode(state.contextMode)
					? state.contextMode
					: DEFAULT_SETTINGS.contextMode,
			daybreak: typeof state.daybreak === "boolean" ? state.daybreak : DEFAULT_SETTINGS.daybreak,
			serviceTier:
				typeof state.serviceTier === "string" && isTier(state.serviceTier)
					? state.serviceTier
					: DEFAULT_SETTINGS.serviceTier,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: OpenAISettings): Promise<void> {
	await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
	const temporary = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, STATE_FILE);
	await chmod(STATE_FILE, 0o600);
}
