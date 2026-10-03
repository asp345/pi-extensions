export interface FileChange {
	path: string;
	diff: string;
}

export interface FileChangeDetails {
	fileChanges: FileChange[];
}

export function fileChangesOf(details: unknown): FileChange[] {
	if (typeof details !== "object" || details === null) return [];
	const changes = Reflect.get(details, "fileChanges");
	if (!Array.isArray(changes)) return [];
	return changes.filter(
		(change): change is FileChange =>
			typeof change === "object" &&
			change !== null &&
			typeof change.path === "string" &&
			typeof change.diff === "string",
	);
}
