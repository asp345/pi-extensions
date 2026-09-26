import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function resolveModel(input: string | undefined, ctx: ExtensionContext): Model<Api> | undefined {
	if (!input || input.trim().toLowerCase() === "parent") return ctx.model;
	const models = ctx.modelRegistry.getAvailable();
	const lower = input.toLowerCase();
	let found = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
	if (!found) {
		const matches = models.filter((model) =>
			`${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(lower),
		);
		if (matches.length === 1) found = matches[0];
	}
	if (!found) throw new Error(`Subagent model ${input} is unavailable.`);
	return found;
}
