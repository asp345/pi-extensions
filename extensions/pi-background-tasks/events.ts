export const BACKGROUND_TASKS_STATE_EVENT = "pi-background-tasks:state";

export interface BackgroundTasksState {
	running: number;
}

export function parseBackgroundTasksState(value: unknown): BackgroundTasksState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const running = Reflect.get(value, "running");
	if (typeof running !== "number" || !Number.isSafeInteger(running) || running < 0) return undefined;
	return { running };
}
