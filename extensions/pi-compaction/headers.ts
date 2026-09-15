const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

export function getOpencodeSessionHeaders(
	model: { provider: string; baseUrl: string },
	sessionId: string | undefined,
): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (model.provider !== "opencode" && model.provider !== "opencode-go" && !matchesHost(model.baseUrl, OPENCODE_HOST))
		return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

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
