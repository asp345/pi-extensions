import type { WebRunCommand } from "./commands.ts";
import type { ConversationTurn, SearchContextMode } from "./context.ts";
import type { SearchResponse } from "./normalize.ts";

export interface SearchRequest {
	query: string;
}

export interface SearchExecutionOptions {
	sessionId?: string;
	contextMode?: SearchContextMode;
	conversationTurns?: ConversationTurn[];
}

export interface WebSearchProvider {
	search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
	execute(command: WebRunCommand, options?: SearchExecutionOptions, signal?: AbortSignal): Promise<SearchResponse>;
	getSessionId(): string;
	setSessionId(id: string): void;
}
