import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { compactCallLine } from "pi-compact-ui";
import { Type } from "typebox";
import { delegationPrompt } from "./delegation.ts";
import { foregroundResult, formatMetadata, metadata, pageText, RESULT_BYTES, result } from "./format.ts";
import type { AgentManager } from "./manager.ts";
import { compactTranscript } from "./transcript.ts";
import type { ThinkingLevel } from "./types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const LaunchParameters = Type.Object({
	title: Type.String({
		minLength: 1,
		maxLength: 120,
		description: "Short task title shown in the subagent list.",
	}),
	prompt: Type.String({
		minLength: 1,
		maxLength: 30_000,
		description:
			"Role of the subagent plus the concrete objective, constraints, and expected deliverable for the delegated task.",
	}),
	context: Type.String({
		minLength: 1,
		maxLength: 12_000,
		description:
			"Only context required to execute the task: relevant paths, symbols, observed behavior, constraints, validation, and any non-obvious project commands. Do not repeat the task or include unrelated parent-conversation history. The parent conversation is not inherited.",
	}),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Run asynchronously; default true. Set false only when the next parent action requires this result.",
		}),
	),
	model: Type.Optional(
		Type.String({
			maxLength: 256,
			description:
				"Optional exact provider/model override. Omit to inherit the parent model. Do not use speed labels such as `fast`.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVELS, { description: "Optional thinking level. Omit to inherit the parent level." }),
	),
});

export function registerSubagentTools(
	pi: ExtensionAPI,
	deps: {
		manager: AgentManager;
		clearPendingNotifications: (id: string) => void;
	},
): void {
	const { manager, clearPendingNotifications } = deps;

	pi.registerTool({
		name: "launch_subagent",
		label: "Launch Subagent",
		description:
			"Launch a subagent in a separate session. State its role and objective in the prompt. Background runs deliver their settled result as steering at the next turn boundary.",
		promptSnippet: "Launch a subagent",
		promptGuidelines: [
			"Use launch_subagent only when the user requests delegation or a substantial independent task needs isolated context or can run concurrently. Otherwise use direct tools. Start one by default; use multiple only for independent, non-overlapping tasks.",
			"Do not use launch_subagent for a few-file inspection, routine validation, or work already in progress.",
			"State the subagent role, the concrete objective, essential context, relevant paths, constraints, and verification in the prompt. The parent conversation is not inherited.",
			"Run launch_subagent in the background unless its result is required for the next parent action. Continue independent work or end the turn; do not poll, wait, or duplicate its work.",
		],
		parameters: LaunchParameters,
		async execute(_callId, params, signal, onUpdate, ctx) {
			const title = params.title.trim();
			if (!title) throw new Error("Subagent title must not be blank.");
			if (!params.prompt.trim()) throw new Error("Subagent task must not be blank.");
			if (!params.context.trim()) throw new Error("Subagent context must not be blank.");
			const prompt = delegationPrompt(title, params.prompt, params.context, ctx.cwd);
			const background = params.run_in_background ?? true;
			const record = manager.spawn(ctx, title, prompt, {
				background,
				model: params.model,
				thinking: params.thinking as ThinkingLevel | undefined,
				signal: background ? undefined : signal,
			});
			if (background) {
				return result(
					`Started ${record.id} (${record.title}) in the background. Its settled result arrives as steering at the next turn boundary; do not sleep, poll, or duplicate its work to wait.`,
					metadata(record),
				);
			}
			const timer = setInterval(() => {
				onUpdate?.(
					result(`Running ${record.title}: ${record.turns} turns, ${record.toolUses} tools.`, metadata(record)),
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
		renderCall(args, theme, context) {
			return compactCallLine("launch_subagent", args, theme, context) as Component;
		},
		renderResult(toolResult, options, _theme, _context): Component {
			if (!options.expanded) return new Container();
			const text = toolResult.content.find((part) => part.type === "text");
			return new Text(text?.type === "text" ? text.text : "", 1, 0);
		},
		renderShell: "self",
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
		renderCall(args, theme, context) {
			const params = args as { id?: unknown; transcript?: unknown };
			const id = typeof params.id === "string" && params.id ? params.id.slice(0, 8) : "…";
			return compactCallLine("get_subagent_result", args, theme, context, {
				name: params.transcript === true ? "transcript" : "result",
				content: id,
			}) as Component;
		},
		renderResult(toolResult, options, _theme, _context): Component {
			if (!options.expanded) return new Container();
			const text = toolResult.content.find((part) => part.type === "text");
			return new Text(text?.type === "text" ? text.text : "", 1, 0);
		},
		renderShell: "self",
		async execute(_callId, params) {
			const record = manager.get(params.id);
			if (!record) return noMatch(manager, params.id, { id: params.id, found: false });
			if (record.status === "running") {
				return result(formatMetadata(record), metadata(record));
			}
			if (!params.transcript) {
				record.resultConsumed = true;
				clearPendingNotifications(record.id);
				return result(
					`${formatMetadata(record)}\n\nFinal answer:\n${record.result || record.error || "No final answer."}`,
					{ ...metadata(record), transcript: false },
				);
			}
			const source = record.messages.length
				? compactTranscript(record.messages)
				: "[Transcript unavailable: the subagent session was not created or has been disposed.]";
			const page = pageText(source, params.offset ?? 0, params.limit ?? RESULT_BYTES);
			if (page.nextOffset === null) {
				record.resultConsumed = true;
				clearPendingNotifications(record.id);
			}
			const suffix = page.nextOffset === null ? "" : `\n\nNext offset: ${page.nextOffset}`;
			return result(`${formatMetadata(record)}\n\nTranscript:\n${page.text}${suffix}`, {
				...metadata(record),
				transcript: true,
				offset: page.offset,
				totalBytes: page.totalBytes,
				nextOffset: page.nextOffset,
			});
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
			const text = params.message.trim();
			if (!text) throw new Error("Steering message must not be blank.");
			const record = manager.get(params.id);
			if (!record) {
				const ok = await manager.steer(params.id, text);
				if (ok) return result(`Steering message sent to ${params.id.trim()}.`, { id: params.id, accepted: true });
				return noMatch(manager, params.id, { id: params.id, accepted: false });
			}
			const ok = await manager.steer(record.id, text);
			return result(ok ? `Steering message sent to ${record.id}.` : `Subagent ${record.id} is not running.`, {
				id: record.id,
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
			if (!record) return noMatch(manager, params.id, { id: params.id, action: params.action });
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
			const resumed = await manager.resume(ctx, record.id, {
				title: record.title,
				background: true,
				thinking: record.thinking,
			});
			return result(`Resumed subagent ${resumed.id} (${resumed.title}) in the background.`, {
				...metadata(resumed),
				action: params.action,
				resumed: true,
			});
		},
	});

	pi.registerTool({
		name: "list_subagents",
		label: "List Subagents",
		description:
			"List all subagents with IDs, titles, and status. Call before get, steer, or control when the ID is unknown.",
		promptSnippet: "List subagents to recover IDs",
		parameters: Type.Object({}),
		async execute() {
			const records = manager.list();
			if (!records.length) return result("No subagents.", { count: 0 });
			return result(records.map((record) => formatMetadata(record)).join("\n\n"), {
				count: records.length,
				ids: records.map((record) => record.id),
			});
		},
	});
}

function noMatch(manager: AgentManager, requestedId: unknown, details: Record<string, unknown>) {
	const wanted = typeof requestedId === "string" ? requestedId.trim() : "";
	const candidates = wanted.length > 0 && wanted.length < 64 ? manager.matches(wanted).map((record) => record.id) : [];
	const hint =
		candidates.length > 1
			? ` Ambiguous prefix; matches ${candidates.join(", ")}. Use the full ID. Call list_subagents to recover IDs.`
			: ` Available: ${manager.describeIds()}. Call list_subagents to recover IDs.`;
	return result(`No subagent matched ${wanted || "(empty)"}.${hint}`, { ...details, candidates });
}
