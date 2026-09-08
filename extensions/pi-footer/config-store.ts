import {
	DEFAULT_CONFIG,
	DEFAULT_DISPLAY_CONFIG,
	type DisplayConfig,
	loadConfig,
	type PiFooterConfig,
	saveConfig,
} from "./config.ts";

/** Loads and persists pi-footer settings; the display config always rides along with the token config. */
export class FooterConfigStore {
	private tokenConfig: PiFooterConfig | null = null;
	private displayConfig: DisplayConfig = {
		...DEFAULT_DISPLAY_CONFIG,
		items: { ...DEFAULT_DISPLAY_CONFIG.items },
	};

	get display(): DisplayConfig {
		return this.displayConfig;
	}

	get loaded(): PiFooterConfig | null {
		return this.tokenConfig;
	}

	/** Effective config, filling in defaults before the first load. */
	get current(): PiFooterConfig {
		return { ...(this.tokenConfig ?? DEFAULT_CONFIG), display: this.displayConfig };
	}

	async load(): Promise<void> {
		this.tokenConfig = await loadConfig();
		this.displayConfig = this.tokenConfig.display;
	}

	async save(config: PiFooterConfig): Promise<void> {
		this.tokenConfig = { ...config, display: this.displayConfig };
		await saveConfig(this.tokenConfig);
	}

	async saveDisplay(display: DisplayConfig): Promise<void> {
		this.displayConfig = display;
		this.tokenConfig = { ...(this.tokenConfig ?? DEFAULT_CONFIG), display };
		await saveConfig(this.tokenConfig);
	}
}
