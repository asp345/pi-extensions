import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
			try {
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			} catch {
				return nextResolve(specifier, context);
			}
		}
		return nextResolve(specifier, context);
	},
});

const { cleanCitationMarkers, formatTerminalHyperlink, formatWebToolResult } = await import("./output.ts");

test("formatTerminalHyperlink emits a valid OSC 8 sequence", () => {
	assert.equal(
		formatTerminalHyperlink("https://example.com", "[1]"),
		"\u001b]8;;https://example.com\u001b\\[1]\u001b]8;;\u001b\\",
	);
	assert.equal(formatTerminalHyperlink("", "[1]"), "[1]");
});

test("cleanCitationMarkers rewrites unicode citation markers to hyperlinked references", () => {
	const text = "Codex \uE200cite\uE202turn0search0\uE201 and \uE200cite\uE2020\u2020Skip to content\uE201";
	const results = [{ ref_id: "turn0search0", title: "OpenAI Codex GitHub", url: "https://github.com/openai/codex" }];

	const cleaned = cleanCitationMarkers(text, results);
	assert.equal(
		cleaned,
		"Codex \u001b]8;;https://github.com/openai/codex\u001b\\[1]\u001b]8;;\u001b\\ and [Skip to content]",
	);
});

test("cleanCitationMarkers resolves raw turn references from the response and the ref index", () => {
	const results = [{ ref_id: "turn0search0", title: "Rust", url: "https://rust-lang.org" }];
	const refIndex = new Map([["turn1view0", { url: "https://doc.rust-lang.org/stable/std/", title: "std docs" }]]);

	const cleaned = cleanCitationMarkers("See [turn0search0, turn1view0, turn2search9]", results, refIndex);
	assert.equal(
		cleaned,
		"See \u001b]8;;https://rust-lang.org\u001b\\[1]\u001b]8;;\u001b\\ \u001b]8;;https://doc.rust-lang.org/stable/std/\u001b\\[turn1view0]\u001b]8;;\u001b\\ [turn2search9]",
	);
});

test("cleanCitationMarkers keeps unknown refs as plain bracketed text", () => {
	const cleaned = cleanCitationMarkers("See \uE200cite\uE202turn5view3\uE201", []);
	assert.equal(cleaned, "See [turn5view3]");
});

test("formatWebToolResult hyperlinks the ref in the Sources list", () => {
	const cmd = { search_query: [{ q: "rust" }] };
	const response = {
		output: "Raw backend output citing \uE200cite\uE202turn0search0\uE201",
		results: [{ ref_id: "turn0search0", title: "Rust", url: "https://rust-lang.org" }],
	};

	const formatted = formatWebToolResult(cmd, response);
	assert.equal(
		formatted.content[0].text,
		"Raw backend output citing \u001b]8;;https://rust-lang.org\u001b\\[1]\u001b]8;;\u001b\\\n\nSources:\n[1] Rust (\u001b]8;;https://rust-lang.org\u001b\\turn0search0\u001b]8;;\u001b\\) - \u001b]8;;https://rust-lang.org\u001b\\https://rust-lang.org\u001b]8;;\u001b\\",
	);
	assert.deepEqual(formatted.details.results, response.results);
	assert.equal(formatted.details.resultCount, 1);
});

test("formatWebToolResult renders results-only responses with hyperlinked refs", () => {
	const cmd = { search_query: [{ q: "rust" }] };
	const response = {
		output: "",
		results: [{ ref_id: "turn0search0", title: "Rust", url: "https://rust-lang.org", snippet: "Systems language" }],
	};

	const formatted = formatWebToolResult(cmd, response);
	assert.match(formatted.content[0].text, /Web Search Results:/);
	assert.match(formatted.content[0].text, /Ref: \[1\] \(\u001b\]8;;https:\/\/rust-lang\.org/);
});

test("formatWebToolResult handles empty output and empty results", () => {
	const formatted = formatWebToolResult({ search_query: [{ q: "x" }] }, { results: [] });
	assert.equal(formatted.content[0].text, "No output or structured web results returned.");
});
