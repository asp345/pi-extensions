import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, ThinkingLevel } from "./types.ts";
import { contentText, message } from "./util.ts";

interface Callbacks {
	onFallback(model: Model<Api>, reason: string): void;
	onReport(summary: string): void;
	onText(text: string): void;
	onTurn(): void;
	onTool(name: string): void;
	onSession(session: AgentSession): void;
}

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

function sameModel(left: Model<Api>, right: Model<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}

function modelName(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
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

function lastAssistantText(session: AgentSession, start: number): string {
	for (let index = session.messages.length - 1; index >= start; index -= 1) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (text) return text;
	}
	return "";
}

function finalError(session: AgentSession, start: number): string | undefined {
	for (let index = session.messages.length - 1; index >= start; index -= 1) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage?.trim() || "provider error";
		if (message.stopReason === "length" && !contentText(message.content).trim())
			return "output token limit reached before an answer";
		return undefined;
	}
	return undefined;
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "AbortError") ||
		/the operation was aborted|operation aborted/iu.test(message(error))
	);
}

function waitForCompaction(session: AgentSession, signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((resolve) => {
		let unsubscribe: () => void = () => undefined;
		const finish = (error?: string) => {
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
			resolve(error);
		};
		const onAbort = () => finish();
		unsubscribe = session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			finish(event.errorMessage ?? (event.aborted ? "Compaction was aborted." : undefined));
		});
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface FallbackPromptOptions {
	signal?: AbortSignal;
	models?: () => Model<Api>[];
	callbacks: Callbacks;
}

export async function promptWithFallbacks(
	session: AgentSession,
	prompt: string,
	start: number,
	options: FallbackPromptOptions,
): Promise<{ text: string; error?: string }> {
	const attempt = async (
		text: string,
		errorStart: number,
	): Promise<{ aborted: boolean; error?: string; allowFallback: boolean }> => {
		let error: string | undefined;
		try {
			if (!options.signal?.aborted) await session.prompt(text);
		} catch (caught) {
			if (isAbortError(caught) && session.isCompacting) {
				const compactionError = await waitForCompaction(session, options.signal);
				if (options.signal?.aborted) return { aborted: true, allowFallback: false };
				if (compactionError) return { aborted: false, error: compactionError, allowFallback: false };
				await new Promise<void>((resolve) => setImmediate(resolve));
				await session.waitForIdle();
			} else {
				error = message(caught);
			}
		}
		if (options.signal?.aborted) return { aborted: true, allowFallback: false };
		return { aborted: false, error: error ?? finalError(session, errorStart), allowFallback: true };
	};
	const first = await attempt(prompt, start);
	if (first.aborted || !first.error) return { text: lastAssistantText(session, start) };
	if (!first.allowFallback) return { text: lastAssistantText(session, start), error: first.error };

	let currentError = first.error;
	const failures = [`Primary model failed: ${currentError}`];
	for (const fallback of remainingModels(session.model, options.models)) {
		try {
			await session.setModel(fallback);
		} catch (error) {
			failures.push(`Fallback model ${modelName(fallback)} failed to initialize: ${message(error)}`);
			continue;
		}
		options.callbacks.onFallback(fallback, currentError);
		const retryStart = session.messages.length;
		const continuation = [
			"The previous model failed before completing the assigned task.",
			"Continue the original task from the existing conversation state using this fallback model.",
			"Do not repeat tool actions that already completed successfully.",
		].join(" ");
		const retry = await attempt(continuation, retryStart);
		if (retry.aborted) return { text: lastAssistantText(session, start) };
		if (!retry.error) {
			return { text: lastAssistantText(session, retryStart) || lastAssistantText(session, start) };
		}
		currentError = retry.error;
		failures.push(`Fallback model ${modelName(fallback)} failed: ${currentError}`);
		if (!retry.allowFallback) break;
	}
	return { text: lastAssistantText(session, start), error: failures.join("; ") };
}
