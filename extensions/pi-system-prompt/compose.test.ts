import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { loadAgentRules } from "./agents.ts";
import { composePromptOptions, dedupeGuidelines, filterContextFiles } from "./compose.ts";

const AGENTS = "# System Instructions\n\nYou are a coding and research agent.\n\nPrefer built-in tools over bash.";
const DOCS = { readme: "/pkg/README.md", docs: "/pkg/docs", examples: "/pkg/examples" };

function options(overrides: Partial<NormalizedBuildSystemPromptOptions> = {}): NormalizedBuildSystemPromptOptions {
	return {
		cwd: "/home/user/proj",
		appendSystemPrompt: "stale appended rules that must be ignored",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read files", bash: "Run commands", web: "Search the web" },
		toolGuidelines: { bash: ["Bash guideline for the test"], web: ["Web guideline for the test"] },
		promptGuidelines: [],
		sections: {},
		contextFiles: [],
		skills: [],
		...overrides,
	};
}

test("loads the bundled agent rules", () => {
	const rules = loadAgentRules();
	assert.ok(rules.includes("You are a coding and research agent."));
});

test("uses bundled rules as the custom prompt and ignores appendSystemPrompt", () => {
	const composed = composePromptOptions(options(), AGENTS, DOCS);
	assert.equal(composed.customPrompt, AGENTS);
	assert.equal(composed.appendSystemPrompt, "");
});

test("places a custom prompt before agent rules", () => {
	const composed = composePromptOptions(options({ customPrompt: "Custom identity." }), AGENTS, DOCS);
	assert.ok(composed.customPrompt?.startsWith("Custom identity.\n\n# System Instructions"));
});

test("builds tools, rules, and docs sections from selected tools", () => {
	const { sections } = composePromptOptions(options(), AGENTS, DOCS);
	assert.ok(sections.tools?.includes("- read: Read files"));
	assert.ok(!sections.tools?.includes("web"));
	assert.ok(sections.rules?.includes("- Bash guideline for the test"));
	assert.ok(!sections.rules?.includes("Web guideline for the test"));
	assert.ok(sections.rules?.endsWith("- Show file paths clearly when working with files"));
	assert.ok(sections.docs?.includes("/pkg/README.md"));
	assert.ok(sections.docs?.includes("/pkg/docs"));
	assert.ok(sections.docs?.includes("/pkg/examples"));
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
	const composed = composePromptOptions(
		options({
			contextFiles: [
				{ path: "/proj/AGENTS.md", content: AGENTS },
				{ path: "/proj/local.md", content: "Local rule" },
			],
		}),
		AGENTS,
		DOCS,
	);
	assert.deepEqual(
		composed.contextFiles?.map((file) => file.path),
		["/proj/local.md"],
	);
});
