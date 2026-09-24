import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompactionConfig } from "./config.ts";

test("parses native compaction selection", () => {
	assert.deepEqual(
		parseCompactionConfig(
			{
				nativeCodex: false,
				nativeClaude: true,
			},
			"config",
		),
		{
			nativeCodex: false,
			nativeClaude: true,
		},
	);
});

test("rejects unsupported settings", () => {
	assert.throws(() => parseCompactionConfig({ autoCompact: false }, "config"), /unsupported setting/u);
	assert.throws(
		() => parseCompactionConfig({ textModel: { provider: "x", id: "y" } }, "config"),
		/unsupported setting/u,
	);
});
