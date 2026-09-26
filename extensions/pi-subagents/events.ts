export const SUBAGENTS_STATE_EVENT = "pi-subagents:state";

interface SubagentsState {
	runningAgentIds: string[];
}

export function parseSubagentsState(value: unknown): SubagentsState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const agentIds = Reflect.get(value, "runningAgentIds");
	if (!Array.isArray(agentIds) || agentIds.some((id) => typeof id !== "string" || !id)) return undefined;
	return { runningAgentIds: [...new Set(agentIds)] };
}
