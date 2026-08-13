export class WebSearchError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = "WebSearchError";
	}
}

export class CodexAuthMissingError extends WebSearchError {
	constructor() {
		super(
			"ChatGPT web search is unavailable because the OpenAI Codex subscription is not authenticated. Run /login and select 'ChatGPT Plus/Pro (Codex)'.",
			"CODEX_AUTH_MISSING",
		);
		this.name = "CodexAuthMissingError";
	}
}

export class CodexAuthExpiredError extends WebSearchError {
	constructor() {
		super(
			"ChatGPT authentication expired or unauthorized. Run /login and select 'ChatGPT Plus/Pro (Codex)' to re-authenticate.",
			"CODEX_AUTH_EXPIRED",
		);
		this.name = "CodexAuthExpiredError";
	}
}

export class CodexRateLimitError extends WebSearchError {
	constructor() {
		super("Codex web search rate limit exceeded. Please wait before retrying.", "CODEX_RATE_LIMIT");
		this.name = "CodexRateLimitError";
	}
}

export class CodexHttpError extends WebSearchError {
	constructor(
		public readonly statusCode: number,
		details: string,
	) {
		super(`Codex search HTTP ${statusCode}: ${details}`, "CODEX_HTTP_ERROR");
		this.name = "CodexHttpError";
	}
}

export class WebSearchTimeoutError extends WebSearchError {
	constructor(ms: number) {
		super(`Web search request timed out after ${ms}ms`, "WEB_SEARCH_TIMEOUT");
		this.name = "WebSearchTimeoutError";
	}
}

export class WebSearchCancelledError extends WebSearchError {
	constructor() {
		super("Web search request was cancelled", "WEB_SEARCH_CANCELLED");
		this.name = "WebSearchCancelledError";
	}
}
