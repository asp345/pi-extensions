import assert from "node:assert/strict";
import { test } from "node:test";

const { normalizeRawSearchResult, normalizeSearchResponseBody } = await import("./normalize.ts");

test("normalizeRawSearchResult maps known fields and rejects items without identity", () => {
	assert.deepEqual(normalizeRawSearchResult({ ref_id: " turn0search0 ", url: " https://x.io ", title: " X " }), {
		refId: "turn0search0",
		ref_id: "turn0search0",
		url: "https://x.io",
		title: "X",
		raw: { ref_id: " turn0search0 ", url: " https://x.io ", title: " X " },
	});
	assert.equal(normalizeRawSearchResult({ type: "doc" }), null);
	assert.equal(normalizeRawSearchResult("junk"), null);
});

test("normalizeSearchResponseBody extracts output and filters non-object results", () => {
	const normalized = normalizeSearchResponseBody({
		output: "hello",
		encrypted_output: "blob",
		results: [{ ref_id: "turn0search0", url: "https://x.io" }, null, 5],
	});
	assert.deepEqual(normalized.results, [
		{
			refId: "turn0search0",
			ref_id: "turn0search0",
			url: "https://x.io",
			raw: { ref_id: "turn0search0", url: "https://x.io" },
		},
	]);
	assert.equal(normalized.output, "hello");
	assert.equal(normalized.encrypted_output, "blob");
});

test("normalizeSearchResponseBody returns an empty response for malformed bodies", () => {
	assert.deepEqual(normalizeSearchResponseBody(null), { results: [] });
	assert.deepEqual(normalizeSearchResponseBody("nope"), { results: [] });
});
