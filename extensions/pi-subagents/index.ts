import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { definitionSummary, discoverDefinitions, resolveDefinition } from "./definitions.ts";
import { AgentManager } from "./manager.ts";
import { NotificationQueue } from "./notifications.ts";
import { compactTranscript } from "./runner.ts";
import type { AgentRecord, AgentStatus, DefinitionRegistry, ThinkingLevel, WorktreeInfo } from "./types.ts";
import { AgentsUI } from "./ui.ts";

const RESULT_BYTES = 8_000;
const RESULT_LINES = 120;
const NOTIFICATION_BYTES = 1_200;
const STATE_KIND = "pi-subagent-state";

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

export function delegationPrompt(
	definition: { description: string },
	title: string,
	task: string,
	context: string,
	cwd: string,
): string {
	return [
		"# Delegated assignment",
		`Role: ${definition.description}`,
		`Working directory: ${cwd}`,
		"The parent conversation is not inherited. Work only from this explicit handoff and evidence you inspect yourself.",
		"",
		"## Task",
		`Title: ${title.trim()}`,
		task.trim(),
		"",
		"## Context from parent",
		context.trim(),
	].join("\n");
}

interface SubagentReportDetails {
	id: string;
	type: string;
	title: string;
	summary: string;
}

interface CompletionDetails {
	id: string;
	type: string;
	status: string;
	turns: number;
	toolUses: number;
	durationMs: number;
	usedFallback?: boolean;
}

interface CompletionBatchDetails {
	records: CompletionDetails[];
}

interface StoredAgentState {
	version: 1;
	id: string;
	type: string;
	title: string;
	prompt: string;
	cwd: string;
	status: AgentStatus;
	background: boolean;
	startedAt: number;
	completedAt?: number;
	turns: number;
	toolUses: number;
	result?: string;
	error?: string;
	model?: string;
	models: string[];
	usedFallback?: boolean;
	fallbackReason?: string;
	thinking?: ThinkingLevel;
	sessionFile?: string;
	worktree?: WorktreeInfo;
	worktreeBranch?: string;
	resultConsumed?: boolean;
}

export default function subagents(pi: ExtensionAPI): void {
	let registry: DefinitionRegistry = { definitions: new Map(), errors: [] };
	let currentContext: ExtensionContext | undefined;
	let shuttingDown = false;
	const pendingNotifications = new NotificationQueue<number>((batch) => deliverNotifications(batch));
	let ui: AgentsUI;
	const manager = new AgentManager(
		() => ui?.updateWidget(),
		(record) => notifyCompletion(record),
		(record) => pendingNotifications.delete(record.id),
		(record, reason) => {
			const summary = reason.replace(/\s+/gu, " ").trim();
			currentContext?.ui.notify(
				`${record.type} switched to fallback model ${record.model ?? "configured"}: ${summary.slice(0, 240)}`,
				"warning",
			);
		},
		(record, summary) => {
			const content = bounded(summary, 4_000, 80).text;
			pi.sendMessage<SubagentReportDetails>(
				{
					customType: "subagent-report",
					content: `Progress report from ${record.id} (${record.type}, ${record.title}):\n${content}`,
					display: true,
					details: { id: record.id, type: record.type, title: record.title, summary: content },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		},
		(record) => {
			if (currentContext && manager.get(record.id) === record) pi.appendEntry(STATE_KIND, storeRecord(record));
		},
	);
	ui = new AgentsUI(manager);

	function restoreRecords(ctx: ExtensionContext): AgentRecord[] {
		const latest = new Map<string, StoredAgentState>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KIND) continue;
			const state = parseStoredRecord(entry.data);
			if (state) latest.set(state.id, state);
		}
		return [...latest.values()].flatMap((state) => {
			if (!resolveDefinition(registry, state.type)) return [];
			return [
				{
					...state,
					status: state.status === "running" ? "stopped" : state.status,
					abortController: new AbortController(),
					pendingSteers: [],
				} satisfies AgentRecord,
			];
		});
	}

	function notifyCompletion(record: AgentRecord): void {
		ui.updateWidget();
		if (shuttingDown || !record.background || record.resultConsumed) return;
		pendingNotifications.enqueue(record.id, record.completedAt ?? Date.now());
		currentContext?.ui.notify(
			`${record.type} ${record.status} (${record.id.slice(0, 8)}).`,
			record.status === "completed" ? "info" : "warning",
		);
	}

	function deliverNotifications(pending: ReadonlyMap<string, number>): void {
		if (shuttingDown) return;
		const records = [...pending.keys()].flatMap((id) => {
			const record = manager.get(id);
			return !record || record.resultConsumed || record.status === "running" ? [] : [record];
		});
		if (!records.length) return;
		const perResult = Math.max(200, Math.floor((NOTIFICATION_BYTES - 300) / records.length));
		const content = bounded(
			[
				"Background subagents finished:",
				...records.map((record) => {
					const message =
						record.status === "completed"
							? record.result || "No final answer."
							: record.status === "stopped"
								? "Agent was stopped and can be resumed."
								: record.error || "Agent failed.";
					return `\n${record.id} (${record.type}) ${record.status}${record.usedFallback ? ` via fallback model ${record.model ?? "configured"}` : ""}:\n${bounded(message, perResult, 12).text}`;
				}),
				"\nUse get_subagent_result for bounded transcript retrieval.",
			].join("\n"),
			NOTIFICATION_BYTES,
			60,
		).text;
		pi.sendMessage<CompletionBatchDetails>(
			{
				customType: "subagent-completion",
				content,
				display: true,
				details: { records: records.map(completionDetails) },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	pi.registerMessageRenderer<SubagentReportDetails>("subagent-report", (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		box.addChild(
			new Text(
				`${theme.fg("toolTitle", theme.bold(`Report from ${details.type}`))} ${theme.fg("dim", details.title)}\n${theme.fg("toolOutput", details.summary)}`,
				0,
				0,
			),
		);
		return box;
	});

	pi.registerMessageRenderer<CompletionBatchDetails>("subagent-completion", (message, _options, theme) => {
		const records = message.details?.records;
		if (!records?.length) return undefined;
		const failed = records.some((record) => record.status !== "completed");
		const label = records.length === 1 ? records[0]!.type : `${records.length} subagents`;
		const stats = records
			.map(
				(record) =>
					`${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools${record.usedFallback ? " · fallback" : ""}`,
			)
			.join("; ");
		return new Text(
			`${theme.fg(failed ? "warning" : "success", failed ? "!" : "✓")} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("dim", stats)}`,
			0,
			0,
		);
	});

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
			const definition = resolveDefinition(registry, params.subagent_type.trim());
			if (!definition) {
				throw new Error(
					`Agent configuration error: unknown or disabled subagent ${params.subagent_type}. Available: ${definitionSummary(registry) || "none"}`,
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
				pendingNotifications.delete(record.id);
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
			const definition = resolveDefinition(registry, record.type);
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

	pi.registerCommand("agents", {
		description: "Choose the active subagent context shown above the editor",
		handler: async (args, ctx) => ui.open(ctx, args),
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		currentContext = ctx;
		registry = discoverDefinitions(ctx.cwd, ctx.isProjectTrusted());
		manager.restore(restoreRecords(ctx));
		ui.attach(ctx);
		if (registry.errors.length)
			ctx.ui.notify(`${registry.errors.length} agent definition configuration error(s).`, "warning");
	});
	pi.on("before_agent_start", (event) => {
		const summary = definitionSummary(registry);
		const warning = registry.errors.length ? "\nSome definitions have configuration errors; inspect /agents." : "";
		return { systemPrompt: `${event.systemPrompt}\n\n# Available subagents\n${summary || "None"}${warning}` };
	});
	pi.on("session_shutdown", async () => {
		const context = currentContext;
		shuttingDown = true;
		pendingNotifications.clear();
		await manager.shutdown();
		if (context) ui.detach(context);
		currentContext = undefined;
	});
}

function storeRecord(record: AgentRecord): StoredAgentState {
	return {
		version: 1,
		id: record.id,
		type: record.type,
		title: record.title,
		prompt: record.prompt,
		cwd: record.cwd,
		status: record.status,
		background: record.background,
		startedAt: record.startedAt,
		completedAt: record.completedAt,
		turns: record.turns,
		toolUses: record.toolUses,
		result: record.result ? bounded(record.result, RESULT_BYTES, RESULT_LINES).text : undefined,
		error: record.error,
		model: record.model,
		models: record.models,
		usedFallback: record.usedFallback,
		fallbackReason: record.fallbackReason,
		thinking: record.thinking,
		sessionFile: record.session?.sessionFile ?? record.sessionFile,
		worktree: record.worktree,
		worktreeBranch: record.worktreeBranch,
		resultConsumed: record.resultConsumed,
	};
}

function parseStoredRecord(value: unknown): StoredAgentState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.type !== "string" ||
		typeof value.title !== "string" ||
		typeof value.prompt !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.background !== "boolean" ||
		typeof value.startedAt !== "number" ||
		typeof value.turns !== "number" ||
		typeof value.toolUses !== "number" ||
		!isAgentStatus(value.status) ||
		!Array.isArray(value.models) ||
		!value.models.every((model) => typeof model === "string")
	) {
		return undefined;
	}
	const thinking = typeof value.thinking === "string" && isThinkingLevel(value.thinking) ? value.thinking : undefined;
	return {
		version: 1,
		id: value.id,
		type: value.type,
		title: value.title,
		prompt: value.prompt,
		cwd: value.cwd,
		status: value.status,
		background: value.background,
		startedAt: value.startedAt,
		completedAt: numberValue(value.completedAt),
		turns: value.turns,
		toolUses: value.toolUses,
		result: stringValue(value.result),
		error: stringValue(value.error),
		model: stringValue(value.model),
		models: [...value.models],
		usedFallback: typeof value.usedFallback === "boolean" ? value.usedFallback : undefined,
		fallbackReason: stringValue(value.fallbackReason),
		thinking,
		sessionFile: stringValue(value.sessionFile),
		worktree: parseWorktree(value.worktree),
		worktreeBranch: stringValue(value.worktreeBranch),
		resultConsumed: typeof value.resultConsumed === "boolean" ? value.resultConsumed : undefined,
	};
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return value === "running" || value === "completed" || value === "stopped" || value === "error";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function parseWorktree(value: unknown): WorktreeInfo | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.root !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.branch !== "string" ||
		typeof value.base !== "string"
	) {
		return undefined;
	}
	return { root: value.root, cwd: value.cwd, branch: value.branch, base: value.base };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function foregroundResult(record: AgentRecord): AgentToolResult<Record<string, unknown>> {
	if (record.status === "error") throw new Error(record.error || `${record.type} failed.`);
	if (record.status === "stopped") throw new Error(`${record.type} was stopped.`);
	const page = bounded(record.result || "No final answer.", RESULT_BYTES, RESULT_LINES);
	const suffix = page.truncated
		? `\n\n[Final answer truncated; use get_subagent_result with id ${record.id} for bounded pages.]`
		: "";
	return result(page.text + suffix, metadata(record));
}

function assertParentTools(pi: ExtensionAPI, requested: string[], path: string): void {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	const missing = requested.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Agent configuration error in ${path}: missing tools: ${missing.join(", ")}.`);
}

function result(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: bounded(text, RESULT_BYTES, RESULT_LINES).text }], details };
}

function metadata(record: AgentRecord): Record<string, unknown> {
	return {
		...completionDetails(record),
		background: record.background,
		model: record.session?.model ? `${record.session.model.provider}/${record.session.model.id}` : record.model,
		models: record.models,
		usedFallback: record.usedFallback === true,
		fallbackReason: record.fallbackReason,
		worktreeBranch: record.worktreeBranch,
	};
}

function completionDetails(record: AgentRecord): CompletionDetails {
	return {
		id: record.id,
		type: record.type,
		status: record.status,
		turns: record.turns,
		toolUses: record.toolUses,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		usedFallback: record.usedFallback,
	};
}

function formatMetadata(record: AgentRecord): string {
	return [
		`ID: ${record.id}`,
		`Type: ${record.type}`,
		`Title: ${record.title}`,
		`Status: ${record.status}`,
		`Turns: ${record.turns}`,
		`Tool uses: ${record.toolUses}`,
		record.usedFallback ? `Fallback model: ${record.model ?? "active"}` : "",
		record.fallbackReason ? `Fallback reason: ${bounded(record.fallbackReason, 1_000, 8).text}` : "",
		record.worktreeBranch ? `Worktree branch: ${record.worktreeBranch}` : "",
		record.error ? `Error: ${bounded(record.error, 1_000, 8).text}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function pageText(value: string, offset: number, limit: number) {
	const bytes = Buffer.from(value, "utf8");
	const start = Math.min(offset, bytes.length);
	const end = Math.min(bytes.length, start + Math.min(limit, RESULT_BYTES));
	let text = bytes.subarray(start, end).toString("utf8");
	if (text.endsWith("�") && end < bytes.length) text = text.slice(0, -1);
	text = bounded(text, RESULT_BYTES, RESULT_LINES).text;
	const consumed = Buffer.byteLength(text, "utf8");
	return {
		text,
		offset: start,
		totalBytes: bytes.length,
		nextOffset: start + consumed < bytes.length ? start + consumed : null,
	};
}

function bounded(value: string, maxBytes: number, maxLines: number): { text: string; truncated: boolean } {
	const lines = value.split("\n");
	let text = lines.slice(0, maxLines).join("\n");
	let truncated = lines.length > maxLines;
	let bytes = Buffer.from(text, "utf8");
	if (bytes.length > maxBytes) {
		bytes = bytes.subarray(0, maxBytes);
		text = bytes.toString("utf8").replace(/�$/u, "");
		truncated = true;
	}
	return { text, truncated };
}
