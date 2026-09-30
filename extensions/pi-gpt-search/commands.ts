import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

const SearchQuerySchema = Type.Object({
	q: Type.String(),
	recency: Type.Optional(Type.Number({ description: "days" })),
	domains: Type.Optional(Type.Array(Type.String())),
});
type SearchQuery = Static<typeof SearchQuerySchema>;

const OpenOperationSchema = Type.Object({
	ref_id: Type.String({ description: "e.g. turn0search0" }),
	lineno: Type.Optional(Type.Number()),
});
type OpenOperation = Static<typeof OpenOperationSchema>;

const ClickOperationSchema = Type.Object({
	ref_id: Type.String(),
	id: Type.Number(),
});
const FindOperationSchema = Type.Object({
	ref_id: Type.String(),
	pattern: Type.String(),
});
export const WebRunCommandSchema = Type.Object({
	search_query: Type.Optional(Type.Array(SearchQuerySchema)),
	open: Type.Optional(Type.Array(OpenOperationSchema)),
	click: Type.Optional(Type.Array(ClickOperationSchema)),
	find: Type.Optional(Type.Array(FindOperationSchema)),
	response_length: Type.Optional(StringEnum(["short", "medium", "long"])),
});
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
