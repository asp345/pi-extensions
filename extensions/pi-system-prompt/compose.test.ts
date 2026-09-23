import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { loadAgentRules } from "./agents.ts";
import { composeSystemPrompt, dedupeGuidelines, filterContextFiles, resolveHarnessDocsBlock } from "./compose.ts";

const AGENTS = "# System Instructions\n\nYou are a coding and research agent.\n\nPrefer built-in tools over bash.";

function options(overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return {
		cwd: "/home/user/proj",
		appendSystemPrompt: "stale appended rules that must be ignored",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read files", bash: "Run commands" },
		promptGuidelines: [],
		...overrides,
	};
}

test("loads the bundled agent rules", () => {
	const rules = loadAgentRules();
	assert.ok(rules.includes("You are a coding and research agent."));
});

test("returns undefined without bundled rules", () => {
	assert.equal(composeSystemPrompt(options(), undefined, undefined), undefined);
	assert.equal(composeSystemPrompt(options(), undefined, "  "), undefined);
});

test("uses bundled rules and ignores incoming appendSystemPrompt", () => {
	const prompt = composeSystemPrompt(options(), undefined, AGENTS) ?? assert.fail("expected a prompt");
	assert.ok(prompt.startsWith(AGENTS));
	assert.ok(!prompt.includes("stale appended rules"));
});

test("puts agent rules first and drops harness core preamble", () => {
	const prompt = composeSystemPrompt(options(), undefined, AGENTS) ?? assert.fail("expected a prompt");
	assert.ok(!prompt.includes("You are an expert coding assistant"));
	assert.ok(!prompt.includes("Be concise in your responses"));
	assert.ok(!prompt.includes("Use bash for file operations"));
	assert.ok(prompt.includes("Prefer built-in tools over bash."));
	assert.ok(prompt.includes("Available tools:"));
	assert.ok(prompt.includes("Show file paths clearly when working with files"));
	assert.ok(prompt.endsWith("Current working directory: /home/user/proj"));
});

test("collapses exact duplicates and drops verbatim restatements", () => {
	const kept = dedupeGuidelines(
		["Keep answers short", "keep answers short  ", "Prefer built-in tools over bash."],
		AGENTS,
	);
	assert.deepEqual(kept, ["Keep answers short", "Show file paths clearly when working with files"]);
});

test("does not filter guidelines by phrasing", () => {
	const kept = dedupeGuidelines(["Be concise in your responses", "Use bash for file operations like listing"], AGENTS);
	assert.ok(kept.includes("Be concise in your responses"));
	assert.ok(kept.includes("Use bash for file operations like listing"));
});

test("skips context files already contained in the base", () => {
	const kept = filterContextFiles(
		[
			{ path: "/proj/AGENTS.md", content: `${AGENTS}\n` },
			{ path: "/proj/local.md", content: "Local rule" },
		],
		[AGENTS],
	);
	assert.deepEqual(
		kept.map((file) => file.path),
		["/proj/local.md"],
	);
	const prompt =
		composeSystemPrompt(
			options({ contextFiles: [{ path: "/proj/local.md", content: "Local rule" }] }),
			undefined,
			AGENTS,
		) ?? assert.fail("expected a prompt");
	assert.ok(prompt.includes('<project_instructions path="/proj/local.md">'));
});

test("places a custom prompt before agent rules", () => {
	const prompt =
		composeSystemPrompt(options({ customPrompt: "Custom identity." }), undefined, AGENTS) ??
		assert.fail("expected a prompt");
	assert.ok(prompt.startsWith("Custom identity.\n\n# System Instructions"));
});

test("resolves a short harness docs block keeping core paths", () => {
	const coreBlock = [
		"Pi documentation (read only when the user asks about pi itself):",
		"- Main documentation: /pkg/README.md",
		"- Additional docs: /pkg/docs",
		"- Examples: /pkg/examples (extensions, custom tools, SDK)",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	].join("\n");
	const short = resolveHarnessDocsBlock(`head\n\n${coreBlock}\n\ntail`, undefined) ?? assert.fail("expected a block");
	assert.ok(short.includes("/pkg/README.md"));
	assert.ok(short.includes("/pkg/docs"));
	assert.ok(short.includes("/pkg/examples"));
	assert.ok(!short.includes("When asked about:"));
	assert.ok(short.split("\n").length <= 6);
});

test("falls back to the package dir when core block is absent", () => {
	const short = resolveHarnessDocsBlock("no docs here", "/pkg") ?? assert.fail("expected a block");
	assert.ok(short.includes("/pkg/docs"));
	assert.equal(resolveHarnessDocsBlock("no docs here", undefined), undefined);
});
