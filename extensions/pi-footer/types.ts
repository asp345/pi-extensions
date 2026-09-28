export interface UsageWindow {
	id: string;
	label: string;
	durationMs?: number;
	resetsAt?: number;
}

export interface UsageLimit {
	id: string;
	label: string;
	window?: UsageWindow;
	remainingFraction?: number;
}

export interface ResolvedCredential {
	accessToken: string;
	accountId?: string;
	projectId?: string;
}
