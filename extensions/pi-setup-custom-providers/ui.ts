import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { discoverProviderModels, mergeConfiguredModels } from "./discovery.ts";
import type { CustomModelConfig, CustomProviderConfig, ModelMetadata, ModelsFile } from "./types.ts";
import { API_OPTIONS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, THINKING_LEVELS } from "./types.ts";

const THINKING_FORMATS = ["openai", "openrouter", "deepseek", "together", "zai", "qwen"] as const;
const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const;

type Save = (data: ModelsFile) => Promise<void>;

export const MAX_VISIBLE_ROWS = 10;

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

function positiveInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatPriceMultiplier(value: number | "auto" | undefined): string {
	return value === undefined || value === "auto" ? "auto" : String(value);
}

/** Menu rows are labelled by id and described by this detail line. */
function providerDetail(ctx: ExtensionContext, providerId: string, config: CustomProviderConfig): string {
	const models = `${config.models?.length ?? 0} models`;
	const authenticated = ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
	return authenticated ? models : `${models} · no credentials`;
}

function modelDetail(model: CustomModelConfig): string {
	const reasoning = model.reasoning ? "thinking" : "no thinking";
	return `${reasoning} · ${model.input?.includes("image") ? "image" : "text"}`;
}

function metadataToModel(metadata: ModelMetadata): CustomModelConfig {
	return {
		id: metadata.id,
		name: metadata.name ?? metadata.id,
		reasoning: metadata.reasoning === true,
		thinkingLevelMap: metadata.thinkingLevelMap ? { ...metadata.thinkingLevelMap } : undefined,
		input: metadata.input ?? ["text"],
		cost: metadata.cost,
		contextWindow: metadata.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: metadata.maxTokens ?? DEFAULT_MAX_TOKENS,
		limitSource: metadata.contextWindow || metadata.maxTokens ? "detected" : "default",
	};
}

async function addProvider(ctx: ExtensionContext, data: ModelsFile, save: Save): Promise<void> {
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
		models: [],
	};
	await save(data);
	ctx.ui.notify(`Added provider "${providerId}". Add models here or authenticate with /login.`, "info");
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
		const compat = (config.compat ??= {});
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

async function editThinkingMap(
	ctx: ExtensionContext,
	model: CustomModelConfig,
	save: () => Promise<void>,
): Promise<void> {
	model.reasoning = true;
	for (;;) {
		const map = (model.thinkingLevelMap ??= {});
		const level = await pick(ctx, `Thinking map: ${model.id}`, [
			...THINKING_LEVELS.map((item) => ({
				label: `${item}: ${map[item] === null ? "unsupported" : (map[item] ?? "default")}`,
				value: item,
			})),
			{ label: "Back", value: "back" as const },
		]);
		if (!level || level === "back") return;
		const action = await pick(ctx, `Map ${level}`, [
			{ label: "Use Pi level name", value: "same" },
			{ label: "Custom provider value", value: "custom" },
			{ label: "Unsupported", value: "unsupported" },
			{ label: "Default behavior", value: "default" },
		]);
		if (!action) continue;
		if (action === "same") map[level] = level;
		else if (action === "unsupported") map[level] = null;
		else if (action === "default") delete map[level];
		else {
			const value = (await ctx.ui.input(`Provider value for ${level}`, map[level] ?? level))?.trim();
			if (!value) continue;
			map[level] = value;
		}
		if (Object.keys(map).length === 0) model.thinkingLevelMap = undefined;
		await save();
	}
}

async function editModel(
	ctx: ExtensionContext,
	providerId: string,
	config: CustomProviderConfig,
	model: CustomModelConfig,
	save: () => Promise<void>,
): Promise<void> {
	for (;;) {
		const action = await pick(ctx, `${model.id} — ${modelDetail(model)}`, [
			{ label: `Name: ${model.name ?? model.id}`, value: "name" },
			{ label: `Reasoning: ${model.reasoning === true ? "yes" : "no"}`, value: "reasoning" },
			{ label: "Thinking level mappings", value: "map" },
			{ label: `Image input: ${model.input?.includes("image") ? "yes" : "no"}`, value: "image" },
			{ label: `Context window: ${model.contextWindow ?? DEFAULT_CONTEXT_WINDOW}`, value: "context" },
			{ label: `Max output: ${model.maxTokens ?? DEFAULT_MAX_TOKENS}`, value: "output" },
			{ label: "Remove model", value: "remove" },
			{ label: "Back", value: "back" },
		]);
		if (!action || action === "back") return;
		if (action === "name") {
			const value = await ctx.ui.input("Display name", model.name ?? model.id);
			if (value !== undefined) model.name = value.trim() || model.id;
		} else if (action === "reasoning") {
			model.reasoning = model.reasoning !== true;
		} else if (action === "map") {
			await editThinkingMap(ctx, model, save);
			continue;
		} else if (action === "image") {
			model.input = model.input?.includes("image") ? ["text"] : ["text", "image"];
		} else if (action === "context" || action === "output") {
			const current = action === "context" ? model.contextWindow : model.maxTokens;
			const value = positiveInteger(
				await ctx.ui.input(action === "context" ? "Context window" : "Max output tokens", String(current ?? "")),
			);
			if (!value) {
				ctx.ui.notify("Enter a positive integer", "warning");
				continue;
			}
			if (action === "context") model.contextWindow = value;
			else model.maxTokens = value;
			model.limitSource = "manual";
		} else {
			if (!(await ctx.ui.confirm("Remove model?", `${providerId}/${model.id}`))) continue;
			config.models = (config.models ?? []).filter((candidate) => candidate !== model);
			await save();
			return;
		}
		await save();
	}
}

async function addModel(ctx: ExtensionContext, config: CustomProviderConfig, save: () => Promise<void>): Promise<void> {
	const id = (await ctx.ui.input("Model ID", "vendor/model"))?.trim();
	if (!id) return;
	if (config.models?.some((model) => model.id.toLowerCase() === id.toLowerCase())) {
		ctx.ui.notify(`Model "${id}" already exists`, "warning");
		return;
	}
	const model: CustomModelConfig = {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		limitSource: "default",
	};
	(config.models ??= []).push(model);
	await save();
	await editModel(ctx, "", config, model, save);
}

async function discoverModels(
	ctx: ExtensionContext,
	providerId: string,
	config: CustomProviderConfig,
	save: () => Promise<void>,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(providerId).catch(() => undefined);
		const discovered = await discoverProviderModels(config, auth, controller.signal);
		const existing = new Set((config.models ?? []).map((model) => model.id.toLowerCase()));
		const fresh = [...discovered.values()].filter((model) => !existing.has(model.id.toLowerCase()));
		const action = await pick(ctx, `Discovered ${discovered.size} models`, [
			{ label: `Refresh metadata for ${config.models?.length ?? 0} configured models`, value: "refresh" },
			{ label: `Add all ${fresh.length} new models`, value: "all" },
			{ label: "Choose new models one at a time", value: "choose" },
			{ label: "Back", value: "back" },
		]);
		if (!action || action === "back") return;
		if (action === "refresh") {
			config.models = mergeConfiguredModels(config.models ?? [], discovered);
			await save();
			ctx.ui.notify("Model metadata refreshed", "info");
			return;
		}
		if (action === "all") {
			(config.models ??= []).push(...fresh.map(metadataToModel));
			await save();
			ctx.ui.notify(`Added ${fresh.length} models`, "info");
			return;
		}
		const remaining = [...fresh];
		while (remaining.length > 0) {
			const selected = await pick(ctx, `Add a model (${remaining.length} new)`, [
				{ label: "Done", value: "" },
				...remaining.map((model) => ({
					label: model.id,
					value: model.id,
					description: model.reasoning ? "thinking" : undefined,
				})),
			]);
			if (!selected) return;
			const index = remaining.findIndex((model) => model.id === selected);
			const model = remaining[index];
			if (!model) continue;
			(config.models ??= []).push(metadataToModel(model));
			remaining.splice(index, 1);
			await save();
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		clearTimeout(timeout);
	}
}

async function manageModels(
	ctx: ExtensionContext,
	providerId: string,
	config: CustomProviderConfig,
	save: () => Promise<void>,
): Promise<void> {
	for (;;) {
		const models = config.models ?? [];
		const selected = await pick(ctx, `Models: ${providerId} (${models.length})`, [
			{ label: "Add model", value: "add" },
			{ label: "Back", value: "back" },
			...models.map((model, index) => ({
				label: model.id,
				value: `model:${index}`,
				description: modelDetail(model),
			})),
		]);
		if (!selected || selected === "back") return;
		if (selected === "add") {
			await addModel(ctx, config, save);
			continue;
		}
		const model = models[Number(selected.slice("model:".length))];
		if (model) await editModel(ctx, providerId, config, model, save);
	}
}

async function manageProvider(ctx: ExtensionContext, providerId: string, data: ModelsFile, save: Save): Promise<void> {
	const config = data.providers[providerId];
	if (!config) return;
	const persist = () => save(data);
	for (;;) {
		const action = await pick(ctx, `${providerId} — ${providerDetail(ctx, providerId, config)}`, [
			{ label: "Models", value: "models" },
			{ label: "Discover or refresh models", value: "discover" },
			{ label: "Connection", value: "connection" },
			{ label: "Compatibility", value: "compat" },
			{ label: "Remove provider", value: "remove" },
			{ label: "Back", value: "back" },
		]);
		if (!action || action === "back") return;
		if (action === "models") await manageModels(ctx, providerId, config, persist);
		else if (action === "discover") await discoverModels(ctx, providerId, config, persist);
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

export async function runCustomModelUi(ctx: ExtensionContext, data: ModelsFile, save: Save): Promise<void> {
	for (;;) {
		const entries = Object.entries(data.providers);
		const selected = await pick(ctx, "Custom model providers", [
			{ label: "Add provider", value: "add" },
			{ label: "Done", value: "done" },
			...entries.map(([providerId, config], index) => ({
				label: providerId,
				value: `provider:${index}`,
				description: providerDetail(ctx, providerId, config),
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
