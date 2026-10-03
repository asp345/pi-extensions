import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import {
	CONTEXT_STYLES,
	type ContextStyle,
	DEFAULT_DISPLAY_CONFIG,
	type DisplayKey,
	type FooterConfigStore,
	MIN_TTL_SECONDS,
	type PiFooterConfig,
	SPEED_STYLES,
	type SpeedStyle,
} from "./config.ts";
import type { QuotaController } from "./quota-controller.ts";

const CONTEXT_STYLE_PREVIEWS: Record<ContextStyle, string> = {
	"pct-window": "5.3%/1.0M",
	"used-window": "256k/1.0M",
	pct: "5.3%",
	used: "256k",
	bar: "[██░░░░░░] 25%",
};

const SPEED_STYLE_PREVIEWS: Record<SpeedStyle, string> = {
	"t/s": "77.7 t/s",
	"tok/s": "77.7 tok/s",
	"T/s": "77.7 T/s",
};

const ITEM_NAMES: Record<DisplayKey, string> = {
	input: "Input",
	output: "Output",
	cacheRead: "Cache read",
	cacheWrite: "Cache write",
	totalTokens: "Total tokens",
	cost: "Cost",
	cacheHit: "Cache hit",
	speed: "Speed",
	context: "Context",
	quota5h: "5h quota",
	quotaDay: "Daily quota",
	quotaWeek: "Weekly quota",
	quotaMonth: "Monthly quota",
	quotaBalance: "Balance",
	quotaClock: "Reset time",
};

const DISPLAY_KEYS = Object.keys(DEFAULT_DISPLAY_CONFIG.items) as DisplayKey[];

function styleMenu<T extends string>(
	styles: readonly T[],
	previews: Record<T, string>,
	current: string,
	done: (value?: string) => void,
): Component {
	const items: SelectItem[] = styles.map((style) => ({ value: style, label: style, description: previews[style] }));
	const list = new SelectList(items, items.length, getSelectListTheme());
	list.setSelectedIndex(
		Math.max(
			0,
			items.findIndex((item) => item.value === current),
		),
	);
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done();
	return list;
}

function ttlInput(ctx: ExtensionCommandContext, current: string, done: (value?: string) => void): Component {
	const input = new Input({ placeholder: current });
	input.focused = true;
	input.onSubmit = (value) => {
		if (!value.trim()) {
			done();
			return;
		}
		const seconds = Number.parseInt(value, 10);
		if (Number.isNaN(seconds) || seconds < MIN_TTL_SECONDS) {
			ctx.ui.notify(`Refresh interval must be >= ${MIN_TTL_SECONDS}s`, "warning");
			return;
		}
		done(String(seconds));
	};
	input.onEscape = () => done();
	return input;
}

function settingItems(ctx: ExtensionCommandContext, config: PiFooterConfig): SettingItem[] {
	const { display } = config;
	return [
		...DISPLAY_KEYS.map((key) => ({
			id: key,
			label: ITEM_NAMES[key],
			currentValue: display.items[key] ? "on" : "off",
			values: ["on", "off"],
		})),
		{
			id: "contextStyle",
			label: "Context style",
			currentValue: display.contextStyle,
			submenu: (current, done) => styleMenu(CONTEXT_STYLES, CONTEXT_STYLE_PREVIEWS, current, done),
		},
		{
			id: "speedStyle",
			label: "Speed style",
			currentValue: display.speedStyle,
			submenu: (current, done) => styleMenu(SPEED_STYLES, SPEED_STYLE_PREVIEWS, current, done),
		},
		{
			id: "ttl",
			label: "Quota refresh interval (s)",
			currentValue: String(config.ttl),
			submenu: (current, done) => ttlInput(ctx, current, done),
		},
	];
}

function applySetting(config: PiFooterConfig, id: string, value: string): PiFooterConfig {
	const { display } = config;
	const contextStyle = CONTEXT_STYLES.find((style) => style === value);
	const speedStyle = SPEED_STYLES.find((style) => style === value);
	if (id === "contextStyle" && contextStyle) return { ...config, display: { ...display, contextStyle } };
	if (id === "speedStyle" && speedStyle) return { ...config, display: { ...display, speedStyle } };
	if (id === "ttl") return { ...config, ttl: Number(value) };
	const key = DISPLAY_KEYS.find((displayKey) => displayKey === id);
	if (key) return { ...config, display: { ...display, items: { ...display.items, [key]: value === "on" } } };
	return config;
}

export default function registerFooterCommand(
	pi: ExtensionAPI,
	store: FooterConfigStore,
	quota: QuotaController,
	requestRender: () => void,
): void {
	pi.registerCommand("footer", {
		description: "Footer display settings",
		handler: async (args, ctx) => {
			if ((args.trim() || "config") !== "config") {
				ctx.ui.notify("Usage: /footer [config]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/footer requires the TUI", "warning");
				return;
			}

			let pending = Promise.resolve();
			const save = (id: string, value: string) => {
				pending = pending
					.then(async () => {
						await store.save(applySetting(store.config, id, value));
						if (id === "ttl") quota.restartTimer();
						requestRender();
					})
					.catch((error: unknown) => {
						ctx.ui.notify(`Footer settings failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					});
			};

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const items = settingItems(ctx, store.config);
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Footer settings")), 1, 1));
				const list = new SettingsList(items, Math.min(items.length, 10), getSettingsListTheme(), save, () =>
					done(undefined),
				);
				container.addChild(list);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			});
			await pending;
		},
	});
}
