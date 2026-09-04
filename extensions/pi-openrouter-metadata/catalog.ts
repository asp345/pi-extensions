import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { CostOverride, MetadataOverride, OpenRouterModel } from "./types.ts";
import { displayName, EFFORT_LEVELS, positiveInteger, price, record, string, stringArray } from "./validate.ts";

const MAX_CATALOG_BYTES = 16_000_000;

interface RemoteModel {
	id: string;
	value: Record<string, unknown>;
}

export function mergeOpenRouterModels(baseline: readonly OpenRouterModel[], payload: unknown): OpenRouterModel[] {
	return applyMetadataOverrides(baseline, buildMetadataOverrides(baseline, payload));
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
			contextWindow: value.contextWindow ?? cloned.contextWindow,
			maxTokens: value.maxTokens ?? cloned.maxTokens,
		};
	});
}

export async function readCatalog(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
		await response.body?.cancel();
		throw new Error("OpenRouter model catalog exceeds the response limit.");
	}
	if (!response.body) return JSON.parse(await response.text()) as unknown;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_CATALOG_BYTES) {
				await reader.cancel();
				throw new Error("OpenRouter model catalog exceeds the response limit.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function metadataOverride(value: Record<string, unknown>): MetadataOverride {
	const reasoning = record(value.reasoning);
	const pricing = record(value.pricing);
	const architecture = record(value.architecture);
	const topProvider = record(value.top_provider);
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
		thinkingLevelMap: thinkingLevelMap(reasoning),
		input: input.length ? input : undefined,
		cost: Object.keys(cost).length ? cost : undefined,
		contextWindow: positiveInteger(value.context_length) ?? positiveInteger(topProvider?.context_length),
		maxTokens: positiveInteger(topProvider?.max_completion_tokens),
	};
}

function thinkingLevelMap(reasoning: Record<string, unknown> | undefined): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const efforts = stringArray(reasoning.supported_efforts);
	const supported = new Set(efforts.filter((effort) => EFFORT_LEVELS.some((level) => level === effort)));
	if (!supported.size) return undefined;
	const map: ThinkingLevelMap = {};
	if (reasoning.mandatory === true) map.off = null;
	for (const level of EFFORT_LEVELS) map[level] = supported.has(level) ? level : null;
	return map;
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
