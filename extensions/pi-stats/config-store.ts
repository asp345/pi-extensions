import {
	DEFAULT_CONFIG,
	DEFAULT_DISPLAY_CONFIG,
	type DisplayConfig,
	loadConfig,
	type PiStatsConfig,
	saveConfig,
} from "./config.ts";

/** Loads and persists pi-stats settings; the display config always rides along with the token config. */
export class StatsConfigStore {
	private tokenConfig: PiStatsConfig | null = null;
	private displayConfig: DisplayConfig = {
		...DEFAULT_DISPLAY_CONFIG,
		items: { ...DEFAULT_DISPLAY_CONFIG.items },
	};

	get display(): DisplayConfig {
		return this.displayConfig;
	}

	get loaded(): PiStatsConfig | null {
		return this.tokenConfig;
	}

	/** Effective config, filling in defaults before the first load. */
	get current(): PiStatsConfig {
		return { ...(this.tokenConfig ?? DEFAULT_CONFIG), display: this.displayConfig };
	}

	async load(): Promise<void> {
		this.tokenConfig = await loadConfig();
		this.displayConfig = this.tokenConfig.display;
	}

	async save(config: PiStatsConfig): Promise<void> {
		this.tokenConfig = { ...config, display: this.displayConfig };
		await saveConfig(this.tokenConfig);
	}

	async saveDisplay(display: DisplayConfig): Promise<void> {
		this.displayConfig = display;
		this.tokenConfig = { ...(this.tokenConfig ?? DEFAULT_CONFIG), display };
		await saveConfig(this.tokenConfig);
	}
}
