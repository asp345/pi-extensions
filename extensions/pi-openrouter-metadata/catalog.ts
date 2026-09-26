import { effortLevelMap, record, stringArray } from "../shared/json.ts";
import type { CostOverride, MetadataOverride, OpenRouterModel } from "./types.ts";
import { displayName, price, string } from "./validate.ts";

interface RemoteModel {
	id: string;
	value: Record<string, unknown>;
}

export function buildMetadataOverrides(
	baseline: readonly OpenRouterModel[],
	payload: unknown,
): Map<string, MetadataOverride> {
	const knownIds = new Set(baseline.map((model) => model.id));
	const overrides = new Map<string, MetadataOverride>();
	for (const remote of parseCatalog(payload)) {
		if (!knownIds.has(remote.id)) continue;
		overrides.set(remote.id, metadataOverride(remote.value));
	}
	return overrides;
}

export function applyMetadataOverrides(
	baseline: readonly OpenRouterModel[],
	overrides: ReadonlyMap<string, MetadataOverride>,
): OpenRouterModel[] {
	return baseline.map((model) => {
		const cloned = cloneModel(model);
		const value = overrides.get(model.id);
		if (!value) return cloned;
		return {
			...cloned,
			name: value.name ?? cloned.name,
			reasoning: value.reasoning ?? cloned.reasoning,
			thinkingLevelMap: value.thinkingLevelMap ? { ...value.thinkingLevelMap } : cloned.thinkingLevelMap,
			input: value.input ? [...value.input] : cloned.input,
			cost: value.cost ? { ...cloned.cost, ...value.cost } : cloned.cost,
		};
	});
}

function metadataOverride(value: Record<string, unknown>): MetadataOverride {
	const reasoning = record(value.reasoning);
	const pricing = record(value.pricing);
	const architecture = record(value.architecture);
	const input = stringArray(architecture?.input_modalities).filter(
		(item): item is "text" | "image" => item === "text" || item === "image",
	);
	const cost: CostOverride = {};
	const inputCost = price(pricing?.prompt);
	const outputCost = price(pricing?.completion);
	const cacheRead = price(pricing?.input_cache_read);
	const cacheWrite = price(pricing?.input_cache_write);
	if (inputCost !== undefined) cost.input = inputCost;
	if (outputCost !== undefined) cost.output = outputCost;
	if (cacheRead !== undefined) cost.cacheRead = cacheRead;
	if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
	const supportedParameters = new Set(stringArray(value.supported_parameters));
	const remoteReasoning = reasoning !== undefined || supportedParameters.has("reasoning");
	return {
		name: displayName(value.name),
		reasoning: remoteReasoning ? true : undefined,
		thinkingLevelMap: effortLevelMap(reasoning),
		input: input.length ? input : undefined,
		cost: Object.keys(cost).length ? cost : undefined,
	};
}

function parseCatalog(payload: unknown): RemoteModel[] {
	const root = record(payload);
	if (!root || !Array.isArray(root.data)) throw new Error("OpenRouter model refresh returned an invalid catalog.");
	if (root.data.length > 20_000) throw new Error("OpenRouter model refresh returned too many models.");
	const models: RemoteModel[] = [];
	for (const item of root.data) {
		const value = record(item);
		const id = string(value?.id);
		if (value && id) models.push({ id, value });
	}
	if (!models.length) throw new Error("OpenRouter model refresh returned an empty catalog.");
	return models;
}

function cloneModel(model: OpenRouterModel): OpenRouterModel {
	return {
		...model,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: [...model.input],
		cost: model.cost.tiers
			? { ...model.cost, tiers: model.cost.tiers.map((tier) => ({ ...tier })) }
			: { ...model.cost },
		compat: model.compat ? { ...model.compat } : undefined,
		headers: model.headers ? { ...model.headers } : undefined,
	};
}
