import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { definitionSummary, discoverDefinitions, resolveDefinition } from "./definitions.js";
import { AgentManager } from "./manager.js";
import { compactTranscript, resolveModel, resolveThinking } from "./runner.js";
import type { AgentRecord, DefinitionRegistry } from "./types.js";
import { AgentsUI } from "./ui.js";

const RESULT_BYTES = 12_000;
const RESULT_LINES = 200;
const NOTIFICATION_BYTES = 2_000;

const AgentParameters = Type.Object({
	prompt: Type.String({ minLength: 1, maxLength: 40_000, description: "Self-contained task." }),
	subagent_type: Type.String({ minLength: 1, maxLength: 64, description: "Markdown agent name." }),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Run asynchronously; default true. Set false only when the next parent action requires this result.",
		}),
	),
	model: Type.Optional(Type.String({ maxLength: 256 })),
	max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	resume: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	fork: Type.Optional(Type.Boolean({ description: "Copy the parent's active conversation; default false." })),
});

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

export default function subagents(pi: ExtensionAPI): void {
	let registry: DefinitionRegistry = { definitions: new Map(), errors: [] };
	let currentContext: ExtensionContext | undefined;
	const pendingNotifications = new Map<string, number>();
	const sentNotifications = new Set<string>();
	let notificationFlight: Promise<void> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let shuttingDown = false;
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
	);
	const reload = (ctx: ExtensionContext) => {
		registry = discoverDefinitions(ctx.cwd);
		ui.updateWidget();
	};
	ui = new AgentsUI(manager, () => registry, reload);

	function notifyCompletion(record: AgentRecord): void {
		ui.updateWidget();
		if (shuttingDown || !record.background || record.resultConsumed) return;
		pendingNotifications.set(record.id, record.completedAt ?? Date.now());
		currentContext?.ui.notify(
			`${record.type} ${record.status} (${record.id.slice(0, 8)}).`,
			record.status === "completed" ? "info" : "warning",
		);
		if (currentContext?.isIdle() && !currentContext.hasPendingMessages()) void flushNotifications();
	}

	function flushNotifications(): Promise<void> {
		if (notificationFlight) return notificationFlight;
		notificationFlight = deliverNotifications()
			.then((delivered) => {
				if (!delivered) scheduleNotificationRetry();
			})
			.finally(() => {
				notificationFlight = undefined;
				if (
					pendingNotifications.size &&
					currentContext?.isIdle() &&
					!currentContext.hasPendingMessages() &&
					!retryTimer
				) {
					queueMicrotask(() => void flushNotifications());
				}
			});
		return notificationFlight;
	}

	async function deliverNotifications(): Promise<boolean> {
		if (shuttingDown) return true;
		const batch = [...pendingNotifications.entries()].flatMap(([id, stamp]) => {
			const record = manager.get(id);
			if (!record || record.resultConsumed || record.status === "running") {
				pendingNotifications.delete(id);
				return [];
			}
			return [{ record, stamp }];
		});
		if (!batch.length) return true;
		const records = batch.map(({ record }) => record);
		const perResult = Math.max(200, Math.floor((NOTIFICATION_BYTES - 300) / records.length));
		const content = bounded(
			[
				"Background subagents finished:",
				...records.map((record) => {
					const message =
						record.status === "completed"
							? record.result || "No final answer."
							: record.status === "cancelled"
								? "Agent was cancelled."
								: record.error || "Agent failed.";
					return `\n${record.id} (${record.type}) ${record.status}${record.usedFallback ? ` via fallback model ${record.model ?? "configured"}` : ""}:\n${bounded(message, perResult, 12).text}`;
				}),
				"\nUse get_subagent_result for bounded transcript retrieval.",
			].join("\n"),
			NOTIFICATION_BYTES,
			60,
		).text;
		// pi.sendMessage is fire-and-forget: a failed turn trigger surfaces as a
		// "<runtime>" extension error and cannot be caught here. Notifications sent
		// while idle stay pending until agent_start confirms the triggered run, and
		// agent_settled re-flushes whatever remains.
		const idle = currentContext?.isIdle() === true;
		pi.sendMessage<CompletionBatchDetails>(
			{
				customType: "subagent-completion",
				content,
				display: true,
				details: { records: records.map(completionDetails) },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		for (const { record, stamp } of batch) {
			if (pendingNotifications.get(record.id) !== stamp) continue;
			if (idle) sentNotifications.add(record.id);
			else pendingNotifications.delete(record.id);
		}
		return true;
	}

	function scheduleNotificationRetry(): void {
		if (retryTimer || shuttingDown) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (currentContext?.isIdle() && !currentContext.hasPendingMessages()) void flushNotifications();
		}, 500);
		retryTimer.unref?.();
	}

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
		name: "Agent",
		label: "Agent",
		description:
			"Launch or resume a selected Markdown subagent. Background runs deliver their settled result as a follow-up that resumes the parent automatically.",
		promptSnippet: "Launch or resume a Markdown subagent",
		promptGuidelines: [
			"Agents run in background by default. Set run_in_background false only when the next parent action directly depends on the result.",
			"After launching a background agent, continue independent work or end the turn; its settled result arrives as a follow-up that resumes you automatically. Do not sleep, poll, or launch duplicate work to wait.",
			"Call get_subagent_result early only when you need the result before the completion notification arrives.",
		],
		parameters: AgentParameters,
		async execute(_callId, params, signal, onUpdate, ctx) {
			const prompt = params.prompt.trim();
			const definition = resolveDefinition(registry, params.subagent_type.trim());
			if (!definition) {
				throw new Error(
					`Agent configuration error: unknown or disabled subagent ${params.subagent_type}. Available: ${definitionSummary(registry) || "none"}`,
				);
			}
			if (params.resume && params.fork)
				throw new Error("Agent configuration error: resume cannot be combined with fork.");
			if (params.resume) {
				const existing = manager.get(params.resume);
				if (!existing) throw new Error(`Unknown subagent ID: ${params.resume}`);
				if (existing.type.toLowerCase() !== definition.name.toLowerCase()) {
					throw new Error(`Agent configuration error: ${params.resume} is ${existing.type}, not ${definition.name}.`);
				}
				const background = params.run_in_background ?? definition.runInBackground;
				const model = params.model ? resolveModel(params.model, ctx, definition) : undefined;
				const models = params.model ? [params.model, ...definition.models] : definition.models;
				const record = await manager.resume(ctx, existing.id, prompt, {
					background,
					model,
					models,
					definition,
					thinking: resolveThinking(definition.thinking, ctx),
					maxTurns: params.max_turns ?? definition.maxTurns,
					signal,
				});
				if (background) {
					return result(
						`Resumed ${record.id} (${record.type}) in the background. Its settled result arrives as a follow-up and resumes you automatically; do not sleep or poll to wait.`,
						metadata(record),
					);
				}
				record.resultConsumed = true;
				return foregroundResult(record);
			}

			assertParentTools(pi, definition.tools, definition.path);
			const background = params.run_in_background ?? definition.runInBackground;
			const record = manager.spawn(ctx, definition, prompt, {
				background,
				model: params.model,
				maxTurns: params.max_turns,
				fork: params.fork ?? definition.fork,
				signal,
			});
			if (background) {
				return result(
					`Started ${record.id} (${record.type}) in the background. Its settled result arrives as a follow-up and resumes you automatically; do not sleep, poll, or duplicate its work to wait.`,
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
			const title = `${args.resume ? "Resume" : "Agent"} ${args.subagent_type}`;
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
			"Send one bounded steering message to a running subagent, including one whose session is still starting.",
		promptSnippet: "Redirect a running subagent",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			message: Type.String({ minLength: 1, maxLength: 4_000 }),
		}),
		async execute(_callId, params) {
			const ok = manager.steer(params.id, params.message.trim());
			return result(ok ? `Steering message sent to ${params.id}.` : `Subagent ${params.id} is not running.`, {
				id: params.id,
				accepted: ok,
			});
		},
	});

	pi.registerCommand("agents", {
		description: "Replace the main view with the subagent workspace",
		handler: async (args, ctx) => ui.open(ctx, args),
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		currentContext = ctx;
		registry = discoverDefinitions(ctx.cwd);
		ui.attach(ctx);
		if (registry.errors.length)
			ctx.ui.notify(
				`${registry.errors.length} agent definition configuration error(s). Open /agents for details.`,
				"warning",
			);
	});
	pi.on("agent_settled", async () => flushNotifications());
	pi.on("agent_start", () => {
		for (const id of sentNotifications) pendingNotifications.delete(id);
		sentNotifications.clear();
	});
	pi.on("before_agent_start", (event) => {
		const summary = definitionSummary(registry);
		const warning = registry.errors.length ? "\nSome definitions have configuration errors; inspect /agents." : "";
		return { systemPrompt: `${event.systemPrompt}\n\n# Available subagents\n${summary || "None"}${warning}` };
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
		pendingNotifications.clear();
		sentNotifications.clear();
		await manager.shutdown(ctx.cwd);
		ui.detach(ctx);
		currentContext = undefined;
	});
}

function foregroundResult(record: AgentRecord): AgentToolResult<Record<string, unknown>> {
	if (record.status === "error") throw new Error(record.error || `${record.type} failed.`);
	if (record.status === "cancelled") throw new Error(`${record.type} was cancelled.`);
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
