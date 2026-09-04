import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { definitionSummary, resolveDefinition } from "./definitions.ts";
import { delegationPrompt } from "./delegation.ts";
import { foregroundResult, formatMetadata, metadata, pageText, RESULT_BYTES, result } from "./format.ts";
import type { AgentManager } from "./manager.ts";
import { compactTranscript } from "./transcript.ts";
import type { DefinitionRegistry } from "./types.ts";

const LaunchParameters = Type.Object({
	title: Type.String({
		minLength: 1,
		maxLength: 120,
		description: "Short task title shown in the subagent list.",
	}),
	prompt: Type.String({
		minLength: 1,
		maxLength: 30_000,
		description: "Concrete objective, constraints, and expected deliverable for the delegated task.",
	}),
	context: Type.String({
		minLength: 1,
		maxLength: 12_000,
		description:
			"Only context required to execute the task: relevant paths, symbols, observed behavior, constraints, validation, and any non-obvious project commands. Do not repeat the task or include unrelated parent-conversation history. The parent conversation is not inherited.",
	}),
	subagent_type: Type.String({ minLength: 1, maxLength: 64, description: "Markdown agent name." }),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Run asynchronously; default true. Set false only when the next parent action requires this result.",
		}),
	),
	model: Type.Optional(
		Type.String({
			maxLength: 256,
			description:
				"Optional exact provider/model override. Omit except for special cases. Do not use speed labels such as `fast`.",
		}),
	),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			description: "Optional turn-limit override. Omit to use the agent's configured limit.",
		}),
	),
	fork: Type.Optional(Type.Boolean({ description: "Copy the parent's active conversation; default false." })),
});

export function registerSubagentTools(
	pi: ExtensionAPI,
	deps: {
		manager: AgentManager;
		registry: () => DefinitionRegistry;
		clearPendingNotifications: (id: string) => void;
	},
): void {
	const { manager, registry, clearPendingNotifications } = deps;

	pi.registerTool({
		name: "launch_subagent",
		label: "Launch Subagent",
		description:
			"Launch a selected Markdown subagent. Background runs deliver their settled result as steering at the next turn boundary.",
		promptSnippet: "Launch a Markdown subagent",
		promptGuidelines: [
			"Use launch_subagent only when the user requests delegation or a substantial independent task needs isolated context or can run concurrently. Otherwise use direct tools. Start one by default; use multiple only for independent, non-overlapping tasks.",
			"Do not use launch_subagent for a few-file inspection, routine validation, or work already in progress. Choose the narrowest matching definition.",
			"When calling launch_subagent, provide only the concrete objective, essential context, relevant paths, constraints, and verification. The parent conversation is not inherited; do not use fork merely to provide context.",
			"Run launch_subagent in the background unless its result is required for the next parent action. Continue independent work or end the turn; do not poll, wait, or duplicate its work.",
		],
		parameters: LaunchParameters,
		async execute(_callId, params, signal, onUpdate, ctx) {
			const definition = resolveDefinition(registry(), params.subagent_type.trim());
			if (!definition) {
				throw new Error(
					`Agent configuration error: unknown or disabled subagent ${params.subagent_type}. Available: ${definitionSummary(registry()) || "none"}`,
				);
			}
			if (!params.prompt.trim()) throw new Error("Agent configuration error: task must not be blank.");
			if (!params.context.trim()) throw new Error("Agent configuration error: context must not be blank.");
			if (!params.title.trim()) throw new Error("Agent configuration error: title must not be blank.");
			const prompt = delegationPrompt(definition, params.title, params.prompt, params.context, ctx.cwd);

			assertParentTools(pi, definition.tools, definition.path);
			const background = params.run_in_background ?? definition.runInBackground;
			const record = manager.spawn(ctx, definition, params.title.trim(), prompt, {
				background,
				model: params.model,
				maxTurns: params.max_turns,
				fork: params.fork ?? definition.fork,
				signal: background ? undefined : signal,
			});
			if (background) {
				return result(
					`Started ${record.id} (${record.type}) in the background. Its settled result arrives as steering at the next turn boundary; do not sleep, poll, or duplicate its work to wait.`,
					metadata(record),
				);
			}
			const timer = setInterval(() => {
				onUpdate?.(
					result(`Running ${record.type}: ${record.turns} turns, ${record.toolUses} tools.`, metadata(record)),
				);
			}, 500);
			try {
				await record.promise;
			} finally {
				clearInterval(timer);
			}
			record.resultConsumed = true;
			return foregroundResult(record);
		},
		renderCall(args, theme) {
			const title = `Launch ${args.subagent_type}`;
			const prompt = args.prompt?.replace(/\s+/gu, " ").trim() || "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(title))}\n${theme.fg("dim", prompt.length > 100 ? `${prompt.slice(0, 99)}…` : prompt)}`,
				0,
				0,
			);
		},
		renderResult(toolResult, _options, theme) {
			const text = toolResult.content.find((part) => part.type === "text");
			return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_subagent_result",
		label: "Get Subagent Result",
		description:
			"Return subagent metadata and its final answer, or a bounded paginated transcript containing only user/assistant text and compact tool status markers.",
		promptSnippet: "Retrieve bounded subagent results or a compact transcript",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			transcript: Type.Optional(Type.Boolean()),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: RESULT_BYTES })),
		}),
		async execute(_callId, params) {
			const record = manager.get(params.id);
			if (!record) return result(`No subagent matched ${params.id}.`, { id: params.id, found: false });
			if (record.status === "running") {
				return result(formatMetadata(record), metadata(record));
			}
			const source = params.transcript
				? record.session
					? compactTranscript(record.session)
					: "[Transcript unavailable: the subagent session was not created or has been disposed.]"
				: record.result || record.error || "No final answer.";
			const page = pageText(source, params.offset ?? 0, params.limit ?? RESULT_BYTES);
			if (page.nextOffset === null) {
				record.resultConsumed = true;
				clearPendingNotifications(record.id);
			}
			const suffix = page.nextOffset === null ? "" : `\n\nNext offset: ${page.nextOffset}`;
			return result(
				`${formatMetadata(record)}\n\n${params.transcript ? "Transcript" : "Final answer"}:\n${page.text}${suffix}`,
				{
					...metadata(record),
					transcript: params.transcript === true,
					offset: page.offset,
					totalBytes: page.totalBytes,
					nextOffset: page.nextOffset,
				},
			);
		},
	});

	pi.registerTool({
		name: "steer_subagent",
		label: "Steer Subagent",
		description:
			"Send one bounded steering message to a running subagent, including one whose session is still starting. To request an asynchronous progress report, ask the subagent to summarize its current work and call report_to_parent.",
		promptSnippet: "Steer a running subagent. You can request a progress report",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			message: Type.String({ minLength: 1, maxLength: 4_000 }),
		}),
		async execute(_callId, params) {
			const ok = await manager.steer(params.id, params.message.trim());
			return result(ok ? `Steering message sent to ${params.id}.` : `Subagent ${params.id} is not running.`, {
				id: params.id,
				accepted: ok,
			});
		},
	});

	pi.registerTool({
		name: "control_subagent",
		label: "Control Subagent",
		description:
			"Stop a running subagent while preserving its disk-backed session, or resume any inactive subagent by ID.",
		promptSnippet: "Stop or resume a subagent",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			action: StringEnum(["stop", "resume"] as const),
		}),
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const record = manager.get(params.id);
			if (!record) return result(`No subagent matched ${params.id}.`, { id: params.id, action: params.action });
			if (params.action === "stop") {
				const stopped = manager.stop(params.id);
				return result(
					stopped
						? `Stopped subagent ${params.id}. Its session remains resumable.`
						: `Subagent ${params.id} is not running.`,
					{
						id: params.id,
						action: params.action,
						stopped,
					},
				);
			}
			if (record.status === "running") {
				return result(`Subagent ${params.id} is already running.`, {
					id: params.id,
					action: params.action,
					resumed: false,
				});
			}
			const definition = resolveDefinition(registry(), record.type);
			if (!definition) throw new Error(`Agent configuration error: ${record.type} is unavailable.`);
			const prompt =
				record.session || record.sessionFile ? "Continue the assigned task from where it stopped." : record.prompt;
			const resumed = await manager.resume(ctx, record.id, prompt, {
				title: record.title,
				background: true,
				models: record.models,
				definition,
				thinking: record.thinking,
			});
			return result(`Resumed subagent ${resumed.id} (${resumed.type}) in the background.`, {
				...metadata(resumed),
				action: params.action,
				resumed: true,
			});
		},
	});
}

function assertParentTools(pi: ExtensionAPI, requested: string[], path: string): void {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	const missing = requested.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Agent configuration error in ${path}: missing tools: ${missing.join(", ")}.`);
}
