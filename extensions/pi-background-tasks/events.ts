export const BACKGROUND_TASKS_STATE_EVENT = "pi-background-tasks:state";

interface BackgroundTasksState {
	runningTaskIds: string[];
}

export interface HandoffDetails {
	backgroundTaskId: string;
}

export function handoffTaskId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const id = Reflect.get(details, "backgroundTaskId");
	return typeof id === "string" && id ? id : undefined;
}

export function parseBackgroundTasksState(value: unknown): BackgroundTasksState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const taskIds = Reflect.get(value, "runningTaskIds");
	if (!Array.isArray(taskIds) || taskIds.some((id) => typeof id !== "string" || !id)) return undefined;
	const runningTaskIds = [...new Set(taskIds)];
	return { runningTaskIds };
}
