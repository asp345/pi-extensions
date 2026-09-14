import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { definitionBody } from "./definitions.ts";
import type { AgentDefinition } from "./types.ts";

export function buildSystemPrompt(definition: AgentDefinition, ctx: ExtensionContext, cwd: string): string {
	const body = definitionBody(definition);
	const bridge = `<sub_agent_context>
You are the selected ${definition.name} subagent. Work only on the assigned task.
Use direct tools instead of shell substitutes where practical. Be concise and report evidence.
</sub_agent_context>`;
	const environment = `<active_agent name="${escapeXml(definition.name)}"/>

# Environment
Working directory: ${cwd}`;
	const memory = definition.memory
		? `\n\n# Memory\nMemory scope: ${definition.memory}. Use ${memoryPath(definition, cwd)} when the task requires persistent memory; do not read it speculatively.`
		: "";
	if (definition.promptMode === "append") {
		return `${ctx.getSystemPrompt()}\n\n${bridge}\n\n${environment}\n\n<agent_instructions>\n${body}\n</agent_instructions>${memory}`;
	}
	return `${bridge}\n\n${environment}\n\n${body}${memory}`;
}

function memoryPath(definition: AgentDefinition, cwd: string): string {
	if (definition.memory === "user") return join(getAgentDir(), "agent-memory", definition.name, "MEMORY.md");
	if (definition.memory === "local") return join(cwd, ".agents", "memory", definition.name, "MEMORY.md");
	return join(cwd, ".pi", "agent-memory", definition.name, "MEMORY.md");
}

function escapeXml(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}
