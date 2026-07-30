export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function compact(value: string, limit: number): string {
	const text = value.replace(/\s+/gu, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function onAbort(signal: AbortSignal | undefined, action: () => void): () => void {
	if (!signal) return () => undefined;
	if (signal.aborted) action();
	else signal.addEventListener("abort", action, { once: true });
	return () => signal.removeEventListener("abort", action);
}
