import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";

export function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function runtimeModel(runtime: ModelRuntime, model: Model<Api>): Model<Api> {
	const found = runtime.getModel(model.provider, model.id);
	if (!found) throw new Error(`Subagent model ${modelKey(model)} is unavailable.`);
	return found;
}

export function resolveModel(input: string | undefined, ctx: ExtensionContext): Model<Api> | undefined {
	if (!input || input.trim().toLowerCase() === "parent") return ctx.model;
	const models = ctx.modelRegistry.getAvailable();
	const lower = input.toLowerCase();
	let found = models.find((model) => modelKey(model).toLowerCase() === lower);
	if (!found) {
		const matches = models.filter((model) => `${modelKey(model)} ${model.name ?? ""}`.toLowerCase().includes(lower));
		if (matches.length === 1) found = matches[0];
	}
	if (!found) throw new Error(`Subagent model ${input} is unavailable.`);
	return found;
}

export function availableModelsText(ctx: ExtensionContext): string {
	if (ctx.scopedModels.length === 0) return "";
	return [
		"Available models. Pass the `provider/id` value as `model` to launch_subagent or configure_subagent.",
		...ctx.scopedModels.map(({ model }) => `- ${modelKey(model)}${model.name ? ` (${model.name})` : ""}`),
	].join("\n");
}
