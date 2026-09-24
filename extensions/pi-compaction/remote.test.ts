import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildCompactionRequestBody } from "./remote.ts";

function model(): Model<Api> {
	return { id: "gpt-6-luna" } as Model<Api>;
}

test("keeps wire instructions and tools from the cached payload", () => {
	const body = buildCompactionRequestBody({
		basePayload: {
			instructions: "composed instructions",
			tools: [{ name: "Read" }],
			text: { verbosity: "low" },
			include: ["reasoning.encrypted_content"],
		},
		model: model(),
		input: [],
		instructions: "raw base prompt",
		tools: [{ name: "read" }],
		sessionId: "session-1",
	});
	assert.equal(body.instructions, "composed instructions");
	assert.deepEqual(body.tools, [{ name: "Read" }]);
	assert.deepEqual(body.input, [{ type: "compaction_trigger" }]);
	assert.equal(body.prompt_cache_key, "session-1");
});

test("falls back to params without a cached payload", () => {
	const body = buildCompactionRequestBody({
		basePayload: undefined,
		model: model(),
		input: [],
		instructions: "raw base prompt",
		tools: [{ name: "read" }],
		sessionId: "session-1",
	});
	assert.equal(body.instructions, "raw base prompt");
	assert.deepEqual(body.tools, [{ name: "read" }]);
});

test("drops tools when neither cached nor provided", () => {
	const body = buildCompactionRequestBody({
		basePayload: {},
		model: model(),
		input: [],
		instructions: "raw base prompt",
		tools: undefined,
		sessionId: "session-1",
	});
	assert.equal(body.instructions, "raw base prompt");
	assert.ok(!("tools" in body));
});
