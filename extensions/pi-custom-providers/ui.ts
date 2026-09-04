import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { CustomProviderConfig, CustomProvidersFile } from "./types.ts";
import { API_OPTIONS } from "./types.ts";

const THINKING_FORMATS = ["openai", "openrouter", "deepseek", "together", "zai", "qwen"] as const;
const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const;

type Save = (data: CustomProvidersFile) => Promise<void>;

const MAX_VISIBLE_ROWS = 10;

export interface Choice<T extends string> {
	label: string;
	value: T;
	description?: string;
}

export function filterChoices<T extends string>(choices: readonly Choice<T>[], filter: string): readonly Choice<T>[] {
	const needle = filter.trim().toLowerCase();
	if (!needle) return choices;
	return choices.filter((choice) => `${choice.label} ${choice.description ?? ""}`.toLowerCase().includes(needle));
}

/**
 * A scrolling, filterable picker.
 *
 * The built-in selector draws every option at once, which runs off screen for
 * catalogs with hundreds of models, so lists are rendered through `SelectList`
 * with a bounded viewport and a substring filter.
 */
async function pick<T extends string>(
	ctx: ExtensionContext,
	title: string,
	choices: readonly Choice<T>[],
): Promise<T | undefined> {
	if (choices.length === 0) return undefined;
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select(title, [...choices.map((choice) => choice.label)]);
		return choices.find((choice) => choice.label === selected)?.value;
	}

	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const border = () => new DynamicBorder((text: string) => theme.fg("accent", text));
		let filter = "";
		let list: SelectList | undefined;

		const rebuild = () => {
			const matches = filterChoices(choices, filter);
			const items: SelectItem[] = matches.map((choice) => ({
				value: choice.value,
				label: choice.label,
				description: choice.description,
			}));
			list = new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_ROWS), getSelectListTheme());
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);

			container.clear();
			container.addChild(border());
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(
				new Text(
					filter
						? theme.fg("muted", `filter: ${filter} (${matches.length}/${choices.length})`)
						: theme.fg("dim", "type to filter"),
					1,
					0,
				),
			);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
			container.addChild(border());
		};
		rebuild();

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, "backspace")) {
					filter = filter.slice(0, -1);
					rebuild();
				} else if (data.length === 1 && data >= " " && data !== "\x7f") {
					filter += data;
					rebuild();
				} else {
					list?.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});

	return selected === null || selected === undefined ? undefined : (selected as T);
}

function formatPriceMultiplier(value: number | "auto" | undefined): string {
	return value === undefined || value === "auto" ? "auto" : String(value);
}

/** Menu rows are labelled by id and described by this detail line. */
function providerDetail(ctx: ExtensionContext, providerId: string): string {
	const models = `${ctx.modelRegistry.getProvider(providerId)?.getModels().length ?? 0} models`;
	const authenticated = ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
	return authenticated ? models : `${models} · no credentials`;
}

async function addProvider(ctx: ExtensionContext, data: CustomProvidersFile, save: Save): Promise<void> {
	const providerId = (await ctx.ui.input("Provider ID", "novita"))?.trim();
	if (!providerId) return;
	if (data.providers[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" already exists`, "warning");
		return;
	}
	const baseUrl = (await ctx.ui.input("Base URL", "https://api.example.com/v1"))?.trim();
	if (!baseUrl) return;
	const api = await pick(
		ctx,
		"API format",
		API_OPTIONS.map((value) => ({ label: value, value })),
	);
	if (!api) return;
	const name = (await ctx.ui.input("Display name (optional)", providerId))?.trim();
	const apiKey = (
		await ctx.ui.input(
			"API key config (optional; $ENV_VAR, any placeholder for keyless local servers, or /login later)",
			"$MY_API_KEY",
		)
	)?.trim();
	data.providers[providerId] = {
		name: name || undefined,
		baseUrl,
		api: api as Api,
		apiKey: apiKey || undefined,
	};
	await save(data);
	ctx.ui.notify(`Added provider "${providerId}". Authenticate with /login if credentials are not configured.`, "info");
}

async function editProviderConnection(
	ctx: ExtensionContext,
	providerId: string,
	config: CustomProviderConfig,
	save: () => Promise<void>,
): Promise<void> {
	for (;;) {
		const authenticated = ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
		const action = await pick(ctx, `Connection: ${providerId}`, [
			{ label: `Base URL: ${config.baseUrl ?? "unset"}`, value: "url" },
			{ label: `API: ${config.api ?? "unset"}`, value: "api" },
			{ label: `Display name: ${config.name ?? "unset"}`, value: "name" },
			{ label: `Price multiplier: ${formatPriceMultiplier(config.priceMultiplier)}`, value: "price" },
			{
				label: `Credentials: ${authenticated ? "configured" : `missing, run /login ${providerId}`}`,
				value: "key",
			},
			{ label: "Back", value: "back" },
		]);
		if (!action || action === "back") return;
		if (action === "url") {
			const value = (await ctx.ui.input("Base URL", config.baseUrl))?.trim();
			if (value) config.baseUrl = value;
		} else if (action === "api") {
			const value = await pick(
				ctx,
				"API format",
				API_OPTIONS.map((option) => ({ label: option, value: option })),
			);
			if (value) config.api = value as Api;
		} else if (action === "name") {
			const value = await ctx.ui.input("Display name (blank clears)", config.name);
			if (value !== undefined) config.name = value.trim() || undefined;
		} else if (action === "price") {
			const value = (
				await ctx.ui.input(
					"Price multiplier (auto, or listing value × N = USD per million)",
					formatPriceMultiplier(config.priceMultiplier),
				)
			)?.trim();
			if (value === undefined) continue;
			if (!value || value.toLowerCase() === "auto") config.priceMultiplier = undefined;
			else {
				const parsed = Number(value);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					ctx.ui.notify("Enter 'auto' or a positive number", "warning");
					continue;
				}
				config.priceMultiplier = parsed;
			}
		} else {
			const value = await ctx.ui.input(
				"API key config (blank clears; $ENV_VAR, or any placeholder for keyless local servers)",
				config.apiKey ? "" : "$MY_API_KEY",
			);
			if (value !== undefined) config.apiKey = value.trim() || undefined;
		}
		await save();
	}
}

async function editProviderCompatibility(
	ctx: ExtensionContext,
	providerId: string,
	config: CustomProviderConfig,
	save: () => Promise<void>,
): Promise<void> {
	for (;;) {
		if (!config.compat) config.compat = {};
		const compat = config.compat;
		const action = await pick(ctx, `Compatibility: ${providerId}`, [
			{ label: `Developer role: ${compat.supportsDeveloperRole ?? "default (system)"}`, value: "developer" },
			{ label: `reasoning_effort: ${compat.supportsReasoningEffort ?? "auto"}`, value: "effort" },
			{ label: `Thinking format: ${compat.thinkingFormat ?? "auto"}`, value: "format" },
			{ label: `Max token field: ${compat.maxTokensField ?? "auto"}`, value: "tokens" },
			{ label: "Back", value: "back" },
		]);
		if (!action || action === "back") return;
		if (action === "developer" || action === "effort") {
			const value = await pick(ctx, "Value", [
				{ label: action === "developer" ? "Default (system role)" : "Auto", value: "auto" },
				{ label: "Yes", value: "yes" },
				{ label: "No", value: "no" },
			]);
			const resolved = value === "auto" ? undefined : value === "yes";
			if (action === "developer") compat.supportsDeveloperRole = resolved;
			else compat.supportsReasoningEffort = resolved;
		} else if (action === "format") {
			const value = await pick(ctx, "Thinking request format", [
				{ label: "auto", value: "auto" as const },
				...THINKING_FORMATS.map((option) => ({ label: option, value: option })),
			]);
			compat.thinkingFormat = value === "auto" ? undefined : (value as (typeof THINKING_FORMATS)[number] | undefined);
		} else {
			const value = await pick(ctx, "Max token field", [
				{ label: "auto", value: "auto" as const },
				...MAX_TOKENS_FIELDS.map((option) => ({ label: option, value: option })),
			]);
			compat.maxTokensField = value === "auto" ? undefined : (value as (typeof MAX_TOKENS_FIELDS)[number] | undefined);
		}
		await save();
	}
}

async function refreshModels(ctx: ExtensionContext, providerId: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const result = await ctx.modelRegistry.refresh({
			providers: [providerId],
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) throw new Error("Model catalog refresh timed out");
		const error = result.errors.get(providerId);
		if (error) throw error;
		const count = ctx.modelRegistry.getProvider(providerId)?.getModels().length ?? 0;
		ctx.ui.notify(`Refreshed ${count} models`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		clearTimeout(timeout);
	}
}

async function manageProvider(
	ctx: ExtensionContext,
	providerId: string,
	data: CustomProvidersFile,
	save: Save,
): Promise<void> {
	const config = data.providers[providerId];
	if (!config) return;
	const persist = () => save(data);
	for (;;) {
		const action = await pick(ctx, `${providerId} — ${providerDetail(ctx, providerId)}`, [
			{ label: "Refresh model catalog", value: "discover" },
			{ label: "Connection", value: "connection" },
			{ label: "Compatibility", value: "compat" },
			{ label: "Remove provider", value: "remove" },
			{ label: "Back", value: "back" },
		]);
		if (!action || action === "back") return;
		if (action === "discover") await refreshModels(ctx, providerId);
		else if (action === "connection") await editProviderConnection(ctx, providerId, config, persist);
		else if (action === "compat") await editProviderCompatibility(ctx, providerId, config, persist);
		else {
			if (!(await ctx.ui.confirm("Remove provider?", providerId))) continue;
			delete data.providers[providerId];
			await persist();
			return;
		}
	}
}

export async function runCustomProvidersUi(
	ctx: ExtensionContext,
	data: CustomProvidersFile,
	save: Save,
): Promise<void> {
	for (;;) {
		const entries = Object.entries(data.providers);
		const selected = await pick(ctx, "Custom providers", [
			{ label: "Add provider", value: "add" },
			{ label: "Done", value: "done" },
			...entries.map(([providerId], index) => ({
				label: providerId,
				value: `provider:${index}`,
				description: providerDetail(ctx, providerId),
			})),
		]);
		if (!selected || selected === "done") return;
		if (selected === "add") {
			await addProvider(ctx, data, save);
			continue;
		}
		const entry = entries[Number(selected.slice("provider:".length))];
		if (entry) await manageProvider(ctx, entry[0], data, save);
	}
}
