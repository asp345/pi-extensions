import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { delegationPrompt } from "./delegation.ts";
import type { SubagentManager } from "./manager.ts";
import { resolveModel } from "./models.ts";
import { type AgentRecord, agentStatus, THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

function result(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

export function formatRecord(record: AgentRecord): string {
	const status = agentStatus(record);
	return [
		`${record.name} · ${status}${record.activity ? ` (${record.activity})` : ""}`,
		`ID: ${record.id}`,
		`Model: ${record.model ?? "parent"}${record.thinking ? `:${record.thinking}` : ""}`,
		`Cost: $${record.cost.toFixed(2)}`,
		record.lastError ? `Last error: ${record.lastError}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function noMatch(manager: SubagentManager, ref: string): never {
	throw new Error(`No subagent matched ${ref.trim() || "(empty)"}. Available: ${manager.describe()}.`);
}

export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerTool({
		name: "launch_subagent",
		label: "Launch Subagent",
		description:
			"Launch a subagent in a separate in-process session and return its handle immediately. The subagent replies with messages that arrive at a later parent turn.",
		promptSnippet: "Launch a subagent",
		promptGuidelines: [
			"Use launch_subagent only when the user requests delegation or a substantial independent task needs isolated context or can run concurrently. Otherwise use direct tools. Start one by default; use multiple only for independent, non-overlapping tasks.",
			"Do not use launch_subagent for a few-file inspection, routine validation, or work already in progress.",
			"State the subagent role, the concrete objective, essential context, relevant paths, constraints, and verification in the prompt. The parent conversation is not inherited.",
			"launch_subagent returns at admission. Results arrive only as messages from the subagent at a later turn. Continue independent work or end the turn; do not poll, wait, or duplicate its work.",
			"To give an existing subagent follow-up work in its own context, use send_message instead of launching a new one.",
		],
		parameters: Type.Object({
			name: Type.String({
				minLength: 1,
				maxLength: 64,
				description: "Unique short name for the subagent, used to address it with send_message.",
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = params.name.trim();
			if (!name) throw new Error("Subagent name must not be blank.");
			if (!params.prompt.trim()) throw new Error("Subagent prompt must not be blank.");
			if (!params.context.trim()) throw new Error("Subagent context must not be blank.");
			const record = await manager.launch(ctx, {
				name,
				prompt: delegationPrompt(params.prompt, params.context, ctx.cwd),
				model: resolveModel(params.model, ctx),
				thinking: (params.thinking as ThinkingLevel | undefined) ?? (ctx.thinkingLevel as ThinkingLevel | undefined),
			});
			return result(
				`Started subagent ${record.name} (${record.id}) with ${record.model ?? "the parent model"}. Its replies arrive as messages from child:${record.name}; do not poll or wait.`,
				{ id: record.id, name: record.name, model: record.model, thinking: record.thinking },
			);
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to a subagent by name or ID. A running subagent receives it as steering; an inactive subagent is reopened and starts a new turn in its existing session and context.",
		promptSnippet: "Send a message to a subagent",
		parameters: Type.Object({
			to: Type.String({ minLength: 1, maxLength: 64, description: "Subagent name or ID." }),
			message: Type.String({ minLength: 1, maxLength: 12_000 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const message = params.message.trim();
			if (!message) throw new Error("Message must not be blank.");
			const record = manager.find(params.to) ?? noMatch(manager, params.to);
			const outcome = await manager.send(ctx, record, message);
			const text =
				outcome === "steered"
					? `Delivered to running subagent ${record.name} as steering.`
					: outcome === "resumed"
						? `Reopened subagent ${record.name} from its session and started a turn.`
						: `Started a new turn in subagent ${record.name}.`;
			return result(`${text} Its replies arrive as messages from child:${record.name}.`, {
				id: record.id,
				name: record.name,
				outcome,
			});
		},
	});

	pi.registerTool({
		name: "list_subagents",
		label: "List Subagents",
		description: "List subagents with name, ID, status (running, inactive), model, and cost.",
		promptSnippet: "List subagents",
		parameters: Type.Object({}),
		async execute() {
			const records = manager.list();
			if (!records.length) return result("No subagents.", { count: 0 });
			return result(records.map(formatRecord).join("\n\n"), {
				count: records.length,
				ids: records.map((record) => record.id),
			});
		},
	});

	pi.registerTool({
		name: "stop_subagent",
		label: "Stop Subagent",
		description:
			"Stop a running subagent by name or ID. Its session is kept; send_message starts a new turn in the same context.",
		promptSnippet: "Stop a running subagent",
		parameters: Type.Object({
			to: Type.String({ minLength: 1, maxLength: 64, description: "Subagent name or ID." }),
		}),
		async execute(_toolCallId, params) {
			const record = manager.find(params.to) ?? noMatch(manager, params.to);
			const stopped = manager.stop(record, "parent");
			return result(stopped ? `Stopping subagent ${record.name}.` : `Subagent ${record.name} is not running.`, {
				id: record.id,
				name: record.name,
				stopped,
			});
		},
	});
}
