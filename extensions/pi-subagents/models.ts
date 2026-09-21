import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types.ts";

export function resolveThinking(input: ThinkingLevel | undefined, ctx: ExtensionContext): ThinkingLevel | undefined {
	return input ?? (ctx.thinkingLevel as ThinkingLevel | undefined);
}

export function resolveModel(input: string | undefined, ctx: ExtensionContext): Model<Api> | undefined {
	if (!input || input.trim().toLowerCase() === "parent") return ctx.model as Model<Api> | undefined;
	const registry = ctx.modelRegistry as unknown as {
		find(provider: string, id: string): Model<Api> | undefined;
		getAvailable?: () => Model<Api>[];
		getAll?: () => Model<Api>[];
	};
	const models = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	const lower = input.toLowerCase();
	let found = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
	if (!found) {
		const matches = models.filter((model) =>
			`${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(lower),
		);
		if (matches.length === 1) found = matches[0];
	}
	if (!found && input.includes("/")) {
		const slash = input.indexOf("/");
		found = registry.find(input.slice(0, slash), input.slice(slash + 1));
	}
	if (!found) throw new Error(`Subagent model ${input} is unavailable.`);
	return found;
}
