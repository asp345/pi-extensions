export const BACKGROUND_TASKS_STATE_EVENT = "pi-background-tasks:state";

interface BackgroundTasksState {
	runningTaskIds: string[];
}

export function parseBackgroundTasksState(value: unknown): BackgroundTasksState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const taskIds = Reflect.get(value, "runningTaskIds");
	if (!Array.isArray(taskIds) || taskIds.some((id) => typeof id !== "string" || !id)) return undefined;
	const runningTaskIds = [...new Set(taskIds)];
	return { runningTaskIds };
}
