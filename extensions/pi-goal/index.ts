import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BACKGROUND_TASKS_STATE_EVENT, parseBackgroundTasksState } from "../pi-background-tasks/events.js";
import {
	createGoal,
	type GoalContext,
	GoalRuntime,
	type GoalState,
	loadGoal,
	MAX_OBJECTIVE,
	rejection,
	resumeGoal,
} from "./runtime.js";

const MAX_REASON = 1_000;
const MAX_EVIDENCE = 4_000;
const SUBCOMMANDS = ["status", "pause", "resume", "clear"];

export default function goalExtension(pi: ExtensionAPI) {
	const runtime = new GoalRuntime(pi);
	let activeContext: GoalContext | undefined;

	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Mark the active /goal complete only after all required work is finished and verified, using its current goal_id.",
		parameters: Type.Object({
			goal_id: Type.String({ description: "Exact ID from the current active /goal prompt." }),
			summary: Type.String({
				description: "What was completed and the evidence that verified it.",
			}),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const requestedId = params.goal_id.trim();
			const summary = params.summary.trim();
			const rejected = rejection(runtime.goal, requestedId) ?? completionRejection(summary);
			if (rejected) return rejectedResult("Goal completion rejected", rejected, requestedId);

			const objective = runtime.goal?.objective ?? "";
			if (runtime.goal) {
				runtime.goal.status = "complete";
				runtime.goal.updatedAt = Date.now();
				runtime.persist();
			}
			runtime.setGoal(undefined, ctx);
			ctx.ui.notify(`Goal complete: ${safeText(objective, 160)}`, "info");
			return {
				content: [{ type: "text" as const, text: `Goal complete: ${summary}` }],
				details: { goal_id: requestedId, summary },
				terminate: true as const,
			};
		},
	});

	pi.registerTool({
		name: "goal_blocked",
		label: "Goal Blocked",
		description:
			"Stop the active /goal only at a true impasse after the same external blocker recurs for at least three consecutive goal turns.",
		parameters: Type.Object({
			goal_id: Type.String({ description: "Exact ID from the current active /goal prompt." }),
			reason: Type.String({ minLength: 1, maxLength: MAX_REASON }),
			evidence: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE }),
			repeated_turns: Type.Integer({ minimum: 3 }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const requestedId = params.goal_id.trim();
			const reason = params.reason.trim();
			const evidence = params.evidence.trim();
			const rejected =
				rejection(runtime.goal, requestedId) ??
				(!reason ? "reason is empty" : !evidence ? "evidence is empty" : undefined);
			if (rejected) return rejectedResult("goal_blocked rejected", rejected, requestedId);

			runtime.cancelContinuation();
			if (runtime.goal) {
				runtime.goal.status = "blocked";
				runtime.goal.reason = reason;
				runtime.goal.updatedAt = Date.now();
				runtime.persist();
				runtime.updateStatus(ctx);
			}
			ctx.ui.notify(`Goal blocked: ${safeText(reason, 160)}`, "warning");
			return {
				content: [{ type: "text" as const, text: `Goal blocked: ${reason}` }],
				details: {
					goal_id: requestedId,
					reason,
					evidence,
					repeated_turns: params.repeated_turns,
				},
				terminate: true as const,
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Start, show, pause, resume, or clear one completion goal",
		getArgumentCompletions: (prefix) => {
			const options = SUBCOMMANDS.filter((item) => item.startsWith(prefix.trim()));
			return options.length ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "status") {
				showGoal(runtime.goal, ctx);
				return;
			}
			if (input === "pause") {
				if (!runtime.pause(ctx)) ctx.ui.notify("No active goal to pause.", "warning");
				return;
			}
			if (input === "resume") {
				const current = runtime.goal;
				if (!current || (current.status !== "paused" && current.status !== "blocked")) {
					ctx.ui.notify("No paused or blocked goal to resume.", "warning");
					return;
				}
				runtime.setGoal(resumeGoal(current), ctx);
				await runtime.startPrompt(ctx);
				ctx.ui.notify(`Goal resumed: ${safeText(current.objective, 160)}`, "info");
				return;
			}
			if (input === "clear" || input === "stop") {
				const objective = runtime.goal?.objective;
				runtime.setGoal(undefined, ctx);
				ctx.ui.notify(objective ? `Goal cleared: ${safeText(objective, 160)}` : "No goal is set.", "info");
				return;
			}
			if (SUBCOMMANDS.some((command) => input.startsWith(`${command} `))) {
				ctx.ui.notify(`Usage: /goal ${input.split(/\s/u, 1)[0]}`, "warning");
				return;
			}
			if (input.length > MAX_OBJECTIVE) {
				ctx.ui.notify(`Goal objective is too long (${input.length}/${MAX_OBJECTIVE}).`, "warning");
				return;
			}
			if (runtime.goal) {
				const replace = await ctx.ui.confirm(
					"Replace goal?",
					`Current: ${safeText(runtime.goal.objective, MAX_OBJECTIVE)}\n\nNew: ${safeText(input, MAX_OBJECTIVE)}`,
				);
				if (!replace) return;
			}
			runtime.setGoal(createGoal(input), ctx);
			await runtime.startPrompt(ctx);
			ctx.ui.notify(`Goal started: ${safeText(input, 160)}`, "info");
		},
	});

	const unsubscribeBackgroundTasks = pi.events.on(BACKGROUND_TASKS_STATE_EVENT, (data) => {
		const state = parseBackgroundTasksState(data);
		if (!state) return;
		void runtime.setRunningBackgroundTasks(state.runningTaskIds, activeContext);
	});

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		runtime.goal = loadGoal(ctx);
		runtime.updateStatus(ctx);
		await runtime.resumeRestored(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (runtime.goal) runtime.persist();
		runtime.cancelContinuation();
		if (activeContext === ctx) activeContext = undefined;
		unsubscribeBackgroundTasks();
		ctx.ui.setStatus("goal", undefined);
	});
	pi.on("input", (event) => {
		if (event.source !== "extension") runtime.manualInput();
	});
	pi.on("before_agent_start", (event) => {
		runtime.beforeAgentStart(event.prompt);
	});
	pi.on("tool_call", () => runtime.markToolCall());
	pi.on("message_end", (event, ctx) => runtime.recordAutomaticTurn(ctx, event.message));
	pi.on("agent_end", (event) => runtime.finishAgent(event.messages));
	pi.on("agent_settled", async (_event, ctx) => runtime.settled(ctx));
	pi.on("session_before_compact", (_event) => {
		if (runtime.goal) runtime.persist();
	});
}

function showGoal(goal: GoalState | undefined, ctx: GoalContext) {
	ctx.ui.notify(
		goal
			? `Goal: ${safeText(goal.objective, MAX_OBJECTIVE)}\nStatus: ${goal.status}\nGoal ID: ${goal.id}\nAutomatic turns: ${goal.automaticTurns} (unlimited)`
			: "Usage: /goal <objective>\nNo goal is currently set.",
		"info",
	);
}

function completionRejection(summary: string) {
	if (!summary) return "summary is empty";
	if (
		/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/iu.test(summary) ||
		/\bstill\s+(?:incomplete|failing|fails?)\b/iu.test(summary) ||
		/\btests?\s+(?:still\s+)?fail(?:ing)?\b/iu.test(summary)
	) {
		return "summary says the goal is not complete";
	}
	return undefined;
}

function rejectedResult(prefix: string, reason: string, goalId: string) {
	const text = `${prefix}: ${reason}.`;
	return { content: [{ type: "text" as const, text }], details: { goal_id: goalId } };
}

function safeText(value: string, limit: number) {
	const text = value
		.replace(/[-\u001F\u007F-\u009F]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
