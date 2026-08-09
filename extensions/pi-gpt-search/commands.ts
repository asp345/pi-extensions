import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

export const SearchQuerySchema = Type.Object({
	q: Type.String({ description: "Search query string" }),
	recency: Type.Optional(Type.Number({ description: "Optional recency filter in days" })),
	domains: Type.Optional(Type.Array(Type.String(), { description: "Allowed domain filters" })),
});
export type SearchQuery = Static<typeof SearchQuerySchema>;

export const OpenOperationSchema = Type.Object({
	ref_id: Type.String({ description: "Reference ID of search result or document to open (e.g. turn0search0)" }),
	lineno: Type.Optional(Type.Number({ description: "Line number to jump to" })),
});
export type OpenOperation = Static<typeof OpenOperationSchema>;

export const ClickOperationSchema = Type.Object({
	ref_id: Type.String({ description: "Reference ID of document" }),
	id: Type.Number({ description: "Element ID to click" }),
});
export type ClickOperation = Static<typeof ClickOperationSchema>;

export const FindOperationSchema = Type.Object({
	ref_id: Type.String({ description: "Reference ID of opened document" }),
	pattern: Type.String({ description: "Pattern to find in document" }),
});
export type FindOperation = Static<typeof FindOperationSchema>;

export const ResponseLengthSchema = Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
	description: "Desired length of returned content output",
});
export type ResponseLength = Static<typeof ResponseLengthSchema>;

export const WebRunCommandSchema = Type.Object(
	{
		search_query: Type.Optional(Type.Array(SearchQuerySchema, { description: "Search queries to execute" })),
		open: Type.Optional(Type.Array(OpenOperationSchema, { description: "Open document/page by reference ID" })),
		click: Type.Optional(Type.Array(ClickOperationSchema, { description: "Click element by ID inside document" })),
		find: Type.Optional(Type.Array(FindOperationSchema, { description: "Find pattern inside document" })),
		response_length: Type.Optional(ResponseLengthSchema),
	},
	{ description: "Web research action command" },
);
export type WebRunCommand = Static<typeof WebRunCommandSchema>;

export class InvalidCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCommandError";
	}
}

export function validateWebRunCommand(cmd: unknown): WebRunCommand {
	if (!Check(WebRunCommandSchema, cmd)) {
		const firstError = Errors(WebRunCommandSchema, cmd)[0];
		const path = firstError?.instancePath ?? "/";
		const message = firstError?.message ?? "value does not match the command schema";
		throw new InvalidCommandError(`Command validation failed at ${path || "/"}: ${message}`);
	}
	return normalizeWebRunCommand(cmd as WebRunCommand);
}

function normalizeWebRunCommand(cmd: WebRunCommand): WebRunCommand {
	const normalized: WebRunCommand = {};

	if (cmd.search_query && cmd.search_query.length > 0) {
		const queries = cmd.search_query.map((sq, idx) => {
			const item: SearchQuery = { q: sq.q.trim() };
			if (!item.q) {
				throw new InvalidCommandError(`search_query[${idx}].q cannot be empty`);
			}
			if (sq.recency !== undefined) {
				item.recency = sq.recency;
			}
			const domains = sq.domains?.filter((d) => d.trim()).map((d) => d.trim());
			if (domains && domains.length > 0) {
				item.domains = domains;
			}
			return item;
		});
		normalized.search_query = queries;
	}

	if (cmd.open && cmd.open.length > 0) {
		normalized.open = cmd.open.map((op, idx) => {
			const refId = op.ref_id.trim();
			if (!refId) {
				throw new InvalidCommandError(`open[${idx}].ref_id cannot be empty`);
			}
			const item: OpenOperation = { ref_id: refId };
			if (op.lineno !== undefined) {
				item.lineno = op.lineno;
			}
			return item;
		});
	}

	if (cmd.click && cmd.click.length > 0) {
		normalized.click = cmd.click.map((cl, idx) => {
			const refId = cl.ref_id.trim();
			if (!refId) {
				throw new InvalidCommandError(`click[${idx}].ref_id cannot be empty`);
			}
			return { ref_id: refId, id: cl.id };
		});
	}

	if (cmd.find && cmd.find.length > 0) {
		normalized.find = cmd.find.map((fn, idx) => {
			const refId = fn.ref_id.trim();
			if (!refId) {
				throw new InvalidCommandError(`find[${idx}].ref_id cannot be empty`);
			}
			return { ref_id: refId, pattern: fn.pattern };
		});
	}

	if (cmd.response_length) {
		normalized.response_length = cmd.response_length;
	}

	const hasOperations =
		(normalized.search_query && normalized.search_query.length > 0) ||
		(normalized.open && normalized.open.length > 0) ||
		(normalized.click && normalized.click.length > 0) ||
		(normalized.find && normalized.find.length > 0);

	if (!hasOperations) {
		throw new InvalidCommandError("Command must contain at least one operation: search_query, open, click, or find");
	}

	return normalized;
}

export interface EndpointPayloadOptions {
	sessionId?: string;
	model?: string;
}

export function serializeWebRunPayload(
	command: WebRunCommand,
	options?: EndpointPayloadOptions,
): Record<string, unknown> {
	const commandsObj: Record<string, unknown> = {};

	if (command.search_query && command.search_query.length > 0) {
		commandsObj.search_query = command.search_query;
	}
	if (command.open && command.open.length > 0) {
		commandsObj.open = command.open;
	}
	if (command.click && command.click.length > 0) {
		commandsObj.click = command.click;
	}
	if (command.find && command.find.length > 0) {
		commandsObj.find = command.find;
	}
	if (command.response_length) {
		commandsObj.response_length = command.response_length;
	}

	return {
		id: options?.sessionId ?? "search_1",
		model: options?.model ?? "gpt-4o",
		commands: commandsObj,
	};
}
