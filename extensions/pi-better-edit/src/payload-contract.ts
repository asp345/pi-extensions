import { Type } from "typebox";
import { EDITS_MAX_ITEMS } from "./constants.ts";

export const normalizedEdit = Symbol("normalizedEdit");

export type EditItem = {
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type NormalizedEditRequest = {
	path: string | null;
	edits: EditItem[];
};

function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNormalizedEdit(input: unknown): input is Record<string, unknown> {
	return isRec(input) && (input as Record<string | symbol, unknown>)[normalizedEdit] === true;
}

export const replacementTextSchema = Type.String({
	description: 'Complete replacement for the range; use "" to delete',
});

export const removeFromSchema = Type.String({
	description: "First line to remove (inclusive)",
});

export const removeToSchema = Type.String({
	description: "Last line to remove (inclusive)",
});

const editPathSchema = Type.Union([
	Type.String({
		minLength: 1,
		description: "File path; null infers it from anchors",
	}),
	Type.Null(),
]);

export const editTupleSchema = Type.Unsafe<readonly [string, string, string]>({
	type: "array",
	prefixItems: [removeFromSchema, removeToSchema, replacementTextSchema],
	items: false,
	minItems: 3,
	maxItems: 3,
	description: "[remove_from, remove_to, replacement_text]",
});

export const editToolSchema = Type.Object(
	{
		path: editPathSchema,
		edits: Type.Array(editTupleSchema, {
			description: "Ordered list of edit tuples",
			minItems: 1,
			maxItems: EDITS_MAX_ITEMS,
		}),
	},
	{ additionalProperties: false },
);

export const EDIT_TUPLE_HINT =
	"Edit must be called with exactly one payload. Use the canonical payload " +
	'{"path": path, "edits": [[remove_from, remove_to, replacement_text], ...]}: ' +
	"path is a non-empty string (or null to infer from anchors), each item is a " +
	"fixed 3-position array of two inclusive bare-3-char anchors and the full " +
	"replacement (an empty string deletes the range).";

export const EDIT_DESCRIPTION =
	'Edit verified line ranges in one text file with `{ "path": path, "edits": [[remove_from, remove_to, replacement_text], ...] }`. `path` is a non-empty file path or `null` for anchor-based inference. Each range uses two inclusive bare 3-character HASH anchors from served `HASH│content` rows; `replacement_text` is the complete replacement (`""` deletes). All ranges apply atomically. Errors state whether to retry with echoed anchors or call `read` again.';

export const EDIT_SNIPPET = "Edit verified HASH-anchored line ranges";

export const EDIT_GUIDELINES: string[] = [
	"edit: remove_from and remove_to identify exactly the lines being replaced; do not include surrounding lines.",
	"edit: replacement_text is one string; each `\\n` creates a line, and trailing blank lines must be explicit.",
	"edit: reuse anchors returned by a successful diff. On failure, retry from echoed rows when told 'no read needed'; call `read` only when told to re-read.",
	"edit: use one range normally; batch only independent ranges in the same file.",
];

export function getPayloadPromptFragments(): {
	description: string;
	snippet: string;
	guidelines: string[];
	hint: string;
} {
	return {
		description: EDIT_DESCRIPTION,
		snippet: EDIT_SNIPPET,
		guidelines: [...EDIT_GUIDELINES],
		hint: EDIT_TUPLE_HINT,
	};
}

function emitFilePathDeprecationWarning(filePathValue: unknown, context: string = "payload"): void {
	console.warn(
		`[DEPRECATED] "file_path" is deprecated, use "path" instead (${context}). Received file_path=${JSON.stringify(filePathValue)}. This alias will be removed in a future version.`,
	);
}

export function normalizeFilePathRecord(record: Record<string, unknown>, context: string = "payload"): boolean {
	if (typeof record.path !== "string" && typeof record.file_path === "string") {
		const fp = record.file_path as string;
		emitFilePathDeprecationWarning(fp, context);
		record.path = fp;
		delete record.file_path;
		return true;
	}
	if (typeof record.file_path === "string") {
		emitFilePathDeprecationWarning(record.file_path, context);
		delete record.file_path;
		return true;
	}
	if ("file_path" in record) {
		if (record.file_path !== undefined) {
			emitFilePathDeprecationWarning(record.file_path, context);
		}
		delete record.file_path;
		return true;
	}
	return false;
}

export function itemFromTuple(value: unknown): EditItem | undefined {
	if (!Array.isArray(value) || value.length !== 3) return undefined;
	const [remove_from, remove_to, replacement_text] = value;
	if (typeof remove_from !== "string" || typeof remove_to !== "string" || typeof replacement_text !== "string") {
		return undefined;
	}
	return { remove_from, remove_to, replacement_text };
}

export function editRequestFrom(input: unknown): NormalizedEditRequest | undefined {
	if (!isRec(input)) return undefined;
	const rec = input as Record<string, unknown>;
	const hasFilePath = "file_path" in rec;
	const hasPath = "path" in rec;
	if (hasFilePath) {
		emitFilePathDeprecationWarning(rec.file_path, "edit payload");
	}
	let effectivePath: unknown;
	if (hasPath) {
		effectivePath = rec.path;
		if (
			(typeof effectivePath !== "string" && effectivePath !== null) ||
			(effectivePath === undefined && typeof rec.file_path === "string")
		) {
			if (typeof rec.file_path === "string") {
				effectivePath = rec.file_path;
			}
		}
	} else if (hasFilePath) {
		effectivePath = rec.file_path;
	} else {
		return undefined;
	}

	if (!("edits" in rec)) return undefined;
	const edits = rec.edits;

	if (effectivePath !== null && (typeof effectivePath !== "string" || (effectivePath as string).length === 0)) {
		return undefined;
	}
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	const items: EditItem[] = [];
	for (const item of edits) {
		const normalized = itemFromTuple(item);
		if (!normalized) return undefined;
		items.push(normalized);
	}
	return { path: effectivePath as string | null, edits: items };
}

export function normReq(input: unknown): unknown {
	const valid = editRequestFrom(input);
	if (!valid) return input;
	const record = { path: valid.path, edits: valid.edits };
	Object.defineProperty(record, normalizedEdit, {
		value: true,
		enumerable: false,
	});
	return record;
}

function describeReceived(input: unknown): string {
	if (input === undefined) return "Received no arguments.";
	if (input === null) return "Received null.";
	if (typeof input === "string") return `Received a bare string (${JSON.stringify(input)}).`;
	const json = JSON.stringify(input);
	const preview = typeof json === "string" && json.length > 160 ? `${json.slice(0, 160)}…` : json;
	return `Received: ${preview}`;
}

export function prepareEditArguments(args: unknown): Record<string, unknown> {
	const valid = editRequestFrom(args);
	if (valid) {
		const original = args as Record<string, unknown>;
		return { path: valid.path, edits: original.edits as unknown };
	}
	throw new Error(`[E_BAD_SHAPE] ${EDIT_TUPLE_HINT} ${describeReceived(args)}`);
}

export function getPreviewInput(args: unknown): { path: string | null; edits: EditItem[] } | null {
	const req = editRequestFrom(args);
	if (!req) return null;
	return req;
}

function rejectUnknownFields(obj: Record<string, unknown>, allowed: Set<string>, label: string, hint?: string): void {
	const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		const suffix = hint ? ` ${hint}` : "";
		throw new Error(`[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}`);
	}
}

const ROOT_KS = new Set(["path", "edits"]);

export function assertReq(request: unknown): asserts request is NormalizedEditRequest {
	if (!isNormalizedEdit(request)) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request must be exactly { path, edits: [[remove_from, remove_to, replacement_text], ...] }.",
		);
	}

	rejectUnknownFields(request, ROOT_KS, "Edit request");

	if (request.path !== null && (typeof request.path !== "string" || request.path.length === 0)) {
		throw new Error("[E_BAD_SHAPE] Edit request path must be a non-empty string or null.");
	}

	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "edits" array.');
	}

	for (let index = 0; index < request.edits.length; index++) {
		const item = request.edits[index]!;
		if (
			typeof item.remove_from !== "string" ||
			typeof item.remove_to !== "string" ||
			typeof item.replacement_text !== "string"
		) {
			throw new Error(
				`[E_BAD_SHAPE] Edit request edits[${index}] must be a three-position array [remove_from, remove_to, replacement_text].`,
			);
		}
	}
}
