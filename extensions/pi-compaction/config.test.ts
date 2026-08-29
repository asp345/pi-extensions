import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompactionConfig } from "./config.ts";

test("parses native and text compaction selection", () => {
	assert.deepEqual(
		parseCompactionConfig(
			{
				nativeCodex: false,
				textModel: { provider: "openai-codex", id: "gpt-5.6-luna" },
			},
			"config",
		),
		{
			nativeCodex: false,
			textModel: { provider: "openai-codex", id: "gpt-5.6-luna" },
		},
	);
});

test("rejects unsupported settings and invalid text model selectors", () => {
	assert.throws(() => parseCompactionConfig({ autoCompact: false }, "config"), /unsupported setting/u);
	assert.throws(
		() => parseCompactionConfig({ textModel: { provider: "openai-codex", id: "" } }, "config"),
		/textModel\.id/u,
	);
});
