import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcMessage } from "./rpc.ts";
import type { AgentDefinition, ThinkingLevel } from "./types.ts";
import { contentText } from "./util.ts";

export const FALLBACK_CONTINUATION = [
	"The previous model failed before completing the assigned task.",
	"Continue the original task from the existing conversation state using this fallback model.",
	"Do not repeat tool actions that already completed successfully.",
].join(" ");

export function turnLimitAction(
	turns: number,
	maxTurns: number | undefined,
	wrapping: boolean,
	cancelled: boolean,
): "warn" | "abort" | undefined {
	if (cancelled || !maxTurns || turns < maxTurns) return undefined;
	if (!wrapping) return "warn";
	return turns > maxTurns ? "abort" : undefined;
}

export function resolveThinking(input: AgentDefinition["thinking"], ctx: ExtensionContext): ThinkingLevel | undefined {
	return input === "parent" ? (ctx.thinkingLevel as ThinkingLevel | undefined) : input;
}

export function resolveModels(
	inputs: readonly string[],
	ctx: ExtensionContext,
	definition?: AgentDefinition,
): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const input of inputs) {
		try {
			const model = resolveModel(input, ctx, definition);
			if (model && !models.some((existing) => sameModel(existing, model))) models.push(model);
		} catch {}
	}
	return models;
}

export function resolveModel(
	input: string | undefined,
	ctx: ExtensionContext,
	definition?: AgentDefinition,
): Model<Api> | undefined {
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
	if (!found) {
		throw new Error(
			`Agent configuration error${definition ? ` in ${definition.path}` : ""}: model ${input} is unavailable.`,
		);
	}
	return found;
}

export function sameModel(left: Model<Api>, right: Model<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}

export function remainingModels(current: Model<Api> | undefined, resolve?: () => Model<Api>[]): Model<Api>[] {
	let models: Model<Api>[];
	try {
		models = resolve?.() ?? [];
	} catch {
		return [];
	}
	if (!current) return models;
	const index = models.findIndex((model) => sameModel(model, current));
	return index >= 0 ? models.slice(index + 1) : models.filter((model) => !sameModel(model, current));
}

export function lastAssistantText(messages: readonly RpcMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (text) return text;
	}
	return "";
}

export function finalError(messages: readonly RpcMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage?.trim() || "provider error";
		if (message.stopReason === "length" && !contentText(message.content).trim())
			return "output token limit reached before an answer";
		return undefined;
	}
	return undefined;
}
