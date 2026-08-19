import assert from "node:assert/strict";
import { test } from "node:test";

const { serializeWebRunPayload, validateWebRunCommand, InvalidCommandError } = await import("./commands.ts");

test("validateWebRunCommand normalizes search_query, open, click, and find", () => {
	assert.deepEqual(
		validateWebRunCommand({
			search_query: [{ q: "  openai codex  ", recency: 7, domains: [" github.com ", ""] }],
			open: [{ ref_id: " turn0search0 ", lineno: 12 }],
			click: [{ ref_id: "turn1view0 ", id: 3 }],
			find: [{ ref_id: " turn1view0", pattern: "license" }],
			response_length: "short",
		}),
		{
			search_query: [{ q: "openai codex", recency: 7, domains: ["github.com"] }],
			open: [{ ref_id: "turn0search0", lineno: 12 }],
			click: [{ ref_id: "turn1view0", id: 3 }],
			find: [{ ref_id: "turn1view0", pattern: "license" }],
			response_length: "short",
		},
	);
});

test("validateWebRunCommand rejects empty and operation-less commands", () => {
	assert.throws(() => validateWebRunCommand({ search_query: [{ q: "  " }] }), InvalidCommandError);
	assert.throws(() => validateWebRunCommand({ open: [{ ref_id: "" }] }), InvalidCommandError);
	assert.throws(() => validateWebRunCommand({ response_length: "short" }), InvalidCommandError);
});

test("serializeWebRunPayload serializes commands and drops empty operations", () => {
	assert.deepEqual(
		serializeWebRunPayload({ open: [{ ref_id: "turn0search0" }] }, { sessionId: "s1", model: "gpt-4o" }),
		{ id: "s1", model: "gpt-4o", commands: { open: [{ ref_id: "turn0search0" }] } },
	);
	assert.deepEqual(serializeWebRunPayload({ search_query: [{ q: "rust" }] }, {}), {
		id: "search_1",
		model: "gpt-4o",
		commands: { search_query: [{ q: "rust" }] },
	});
});
