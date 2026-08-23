export function withoutDeletedHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;

	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== null) result[name] = value;
	}
	return result;
}
