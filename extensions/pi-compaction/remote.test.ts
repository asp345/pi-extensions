import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompactionRequestBody } from "./remote.ts";

test("keeps the provider payload and appends the compaction trigger", () => {
	const body = buildCompactionRequestBody(
		{
			model: "gpt-5.6-luna",
			instructions: "composed instructions",
			tools: [{ name: "read" }],
			text: { verbosity: "medium", format: { type: "text" } },
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: "session-1",
			previous_response_id: "resp-1",
			input: [{ type: "message", role: "user", content: "old" }],
		},
		[{ type: "message", role: "user", content: "hello" }],
	);
	assert.equal(body.instructions, "composed instructions");
	assert.deepEqual(body.tools, [{ name: "read" }]);
	assert.equal(body.prompt_cache_key, "session-1");
	assert.deepEqual(body.text, { verbosity: "medium" });
	assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
	assert.deepEqual(body.input, [{ type: "message", role: "user", content: "hello" }, { type: "compaction_trigger" }]);
	assert.ok(!("previous_response_id" in body));
});
