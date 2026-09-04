import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WebRunCommand } from "./commands.ts";
import type { SearchResponse } from "./normalize.ts";

export interface SearchRequest {
	query: string;
}

interface RefIndexEntry {
	url: string;
	title?: string;
}

export type RefIndex = Map<string, RefIndexEntry>;

export interface SearchExecutionOptions {
	sessionId?: string;
}

export interface WebSearchProvider {
	search(request: SearchRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResponse>;
	execute(
		command: WebRunCommand,
		options: SearchExecutionOptions | undefined,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<SearchResponse>;
	getRefIndex(): RefIndex;
	getSessionId(): string;
	setSessionId(id: string): void;
}
