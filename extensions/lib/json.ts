export function parseJson(text: string): unknown {
	return JSON.parse(text) as unknown;
}

export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	const value = parseJson(text);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
