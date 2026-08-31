import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface ThinkingProfilesConfig {
	enabled: boolean;
	levels: Record<string, ThinkingLevel>;
}

const CONFIG_FILE = join(getAgentDir(), "pi-model-thinking.json");
const LEGACY_CONFIG_FILE = join(getAgentDir(), "extensions", "pi-model-thinking", "config.json");
const MODEL_SWITCH_WINDOW_MS = 200;
const APPLY_WINDOW_MS = 100;
const VALID_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_CONFIG: ThinkingProfilesConfig = { enabled: true, levels: {} };

function loadConfig(): ThinkingProfilesConfig {
	try {
		const file = existsSync(CONFIG_FILE) ? CONFIG_FILE : existsSync(LEGACY_CONFIG_FILE) ? LEGACY_CONFIG_FILE : null;
		if (!file) return { ...DEFAULT_CONFIG, levels: {} };
		const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
		const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const levels: Record<string, ThinkingLevel> = {};
		if (saved.levels && typeof saved.levels === "object" && !Array.isArray(saved.levels)) {
			for (const [modelKey, level] of Object.entries(saved.levels)) {
				if (typeof level === "string" && VALID_LEVELS.has(level as ThinkingLevel))
					levels[modelKey] = level as ThinkingLevel;
			}
		}
		const config = { enabled: saved.enabled !== false, levels };
		if (file === LEGACY_CONFIG_FILE) {
			try {
				saveConfig(config);
			} catch {
				// Keep the migrated values in memory when the new file cannot be written.
			}
		}
		return config;
	} catch {
		return { ...DEFAULT_CONFIG, levels: {} };
	}
}

function saveConfig(config: ThinkingProfilesConfig): void {
	writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function modelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export default function modelThinkingExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	let lastApply: { at: number; level: ThinkingLevel } | undefined;
	let lastModelSwitchAt = 0;

	function applyForModel(ctx: ExtensionContext): void {
		const key = modelKey(ctx);
		if (!config.enabled || !key) return;
		const level = config.levels[key];
		if (!level || pi.getThinkingLevel() === level) return;
		lastApply = { at: Date.now(), level };
		pi.setThinkingLevel(level);
	}

	pi.registerCommand("model-thinking", {
		description: "Model-specific thinking levels: on | off | status",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "on" || action === "off") {
				config = { ...config, enabled: action === "on" };
				saveConfig(config);
				ctx.ui.notify(`Model thinking profiles ${action === "on" ? "enabled" : "disabled"}`, "info");
				return;
			}
			ctx.ui.notify(`Model thinking profiles: ${config.enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => applyForModel(ctx));
	pi.on("model_select", (_event, ctx) => {
		lastModelSwitchAt = Date.now();
		applyForModel(ctx);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		const key = modelKey(ctx);
		const level = event.level as ThinkingLevel;
		if (!config.enabled || !key || !VALID_LEVELS.has(level)) return;

		if (lastApply && Date.now() - lastApply.at < APPLY_WINDOW_MS && level === lastApply.level) {
			lastApply = undefined;
			return;
		}

		const switchSnapshot = lastModelSwitchAt;
		setTimeout(() => {
			if (lastModelSwitchAt !== switchSnapshot || config.levels[key] === level) return;
			config = { ...config, levels: { ...config.levels, [key]: level } };
			saveConfig(config);
		}, MODEL_SWITCH_WINDOW_MS);
	});
}
