import type { Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { buildManagedModels, DAYBREAK_BLUE_ALIAS, DAYBREAK_SOL_ID } from "./models.ts";
import { isContextMode, loadSettings, type OpenAISettings, saveSettings } from "./settings.ts";
import { isTier, tierStreamWrappers } from "./tier.ts";

const PROVIDER_IDS = ["openai", "openai-codex"] as const;
const BASE_PROVIDER = Symbol("pi-openai-models-base-provider");
type WrappedProvider = Provider & { [BASE_PROVIDER]?: Provider };

const COMMAND = "openai";

export function wrapOpenAIProvider(base: Provider, getSettings: () => OpenAISettings): Provider {
	const streams = tierStreamWrappers(base, () => getSettings().serviceTier);
	const wrapped: WrappedProvider = {
		...base,
		[BASE_PROVIDER]: base,
		getModels: () => {
			const settings = getSettings();
			return buildManagedModels(base.getModels(), {
				longContext: settings.contextMode === "1m",
				daybreak: settings.daybreak,
			});
		},
		stream: streams.stream,
		streamSimple: streams.streamSimple,
		refreshModels: base.refreshModels?.bind(base),
	};
	return wrapped;
}

function unwrap(current: WrappedProvider | undefined): Provider | undefined {
	if (!current) return undefined;
	if (current[BASE_PROVIDER]) return current[BASE_PROVIDER];
	const legacy = Object.getOwnPropertySymbols(current).find(
		(symbol) => symbol.description === "pi-service-tier-base-provider",
	);
	const base = legacy ? (current as unknown as Record<symbol, Provider | undefined>)[legacy] : undefined;
	return base ?? current;
}

export default async function openaiModels(pi: ExtensionAPI): Promise<void> {
	let settings = await loadSettings();

	function registerProviders(ctx: ExtensionContext): void {
		for (const providerId of PROVIDER_IDS) {
			const base = unwrap(ctx.modelRegistry.getProvider(providerId) as WrappedProvider | undefined);
			if (base) pi.registerProvider(wrapOpenAIProvider(base, () => settings));
		}
	}

	async function applySettings(ctx: ExtensionContext, next: OpenAISettings): Promise<void> {
		const catalogChanged = next.contextMode !== settings.contextMode || next.daybreak !== settings.daybreak;
		settings = next;
		registerProviders(ctx);
		await saveSettings(settings);
		if (!catalogChanged) return;
		if (!ctx.model || !PROVIDER_IDS.includes(ctx.model.provider as (typeof PROVIDER_IDS)[number])) return;
		const targetId = !settings.daybreak && ctx.model.id === DAYBREAK_BLUE_ALIAS ? DAYBREAK_SOL_ID : ctx.model.id;
		const refreshed = ctx.modelRegistry.find(ctx.model.provider, targetId);
		if (refreshed) await pi.setModel(refreshed);
	}

	pi.on("session_start", (_event, ctx) => registerProviders(ctx));

	pi.registerCommand(COMMAND, {
		description: "Configure OpenAI context, Daybreak Blue, and service tier",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`OpenAI: context=${settings.contextMode}, daybreak=${settings.daybreak ? "on" : "off"}, service-tier=${settings.serviceTier}`,
					"info",
				);
				return;
			}

			let pending = Promise.resolve();
			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const items: SettingItem[] = [
					{
						id: "contextMode",
						label: "Context window",
						currentValue: settings.contextMode,
						values: ["standard", "1m"],
					},
					{
						id: "daybreak",
						label: "Daybreak Blue",
						currentValue: settings.daybreak ? "on" : "off",
						values: ["off", "on"],
					},
					{
						id: "serviceTier",
						label: "Service tier",
						currentValue: settings.serviceTier,
						submenu: (currentValue, close) => {
							const tierItems: SelectItem[] = ["default", "flex", "priority"].map((value) => ({
								value,
								label: value === "flex" ? "flex (API only)" : value,
							}));
							const submenu = new SelectList(tierItems, tierItems.length, {
								selectedPrefix: (text) => theme.fg("accent", text),
								selectedText: (text) => theme.fg("accent", text),
								description: (text) => theme.fg("muted", text),
								scrollInfo: (text) => theme.fg("dim", text),
								noMatch: (text) => theme.fg("warning", text),
							});
							const selected = tierItems.findIndex((item) => item.value === currentValue);
							submenu.setSelectedIndex(selected < 0 ? 0 : selected);
							submenu.onSelect = (item) => close(item.value);
							submenu.onCancel = () => close();
							return submenu;
						},
					},
				];
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("OpenAI settings")), 1, 1));
				const list = new SettingsList(
					items,
					items.length + 2,
					getSettingsListTheme(),
					(id, value) => {
						pending = pending.then(() => {
							if (id === "contextMode" && isContextMode(value)) {
								return applySettings(ctx, { ...settings, contextMode: value });
							}
							if (id === "daybreak" && (value === "on" || value === "off")) {
								return applySettings(ctx, { ...settings, daybreak: value === "on" });
							}
							if (id === "serviceTier" && isTier(value)) {
								return applySettings(ctx, { ...settings, serviceTier: value });
							}
						});
					},
					() => done(undefined),
				);
				container.addChild(list);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
			await pending;
		},
	});
}
