import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import lspExtension from "./index.ts";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function extensionHarness() {
	let sessionStart: SessionStartHandler | undefined;
	let activeTools = ["read", "custom"];
	const pi = {
		on(event: string, handler: SessionStartHandler) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool(tool: { name: string }) {
			activeTools.push(tool.name);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;

	lspExtension(pi);
	const start = sessionStart;
	if (!start) throw new Error("pi-lsp did not register session_start");
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	return {
		start: () => start({}, ctx),
		activeTools: () => [...activeTools],
	};
}

test("session start exposes LSP tools only when a configured command resolves", async (t) => {
	const previous = process.env.PI_LSP_CONFIG;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_LSP_CONFIG;
		else process.env.PI_LSP_CONFIG = previous;
	});

	process.env.PI_LSP_CONFIG = JSON.stringify({
		"conditional-test-missing": { command: ["/definitely/missing/pi-lsp"], extensions: ["ts"] },
	});
	const unavailable = extensionHarness();
	await unavailable.start();
	assert.deepEqual(unavailable.activeTools(), ["read", "custom"]);

	process.env.PI_LSP_CONFIG = JSON.stringify({
		"conditional-test-available": { command: [process.execPath], extensions: ["ts"] },
	});
	const available = extensionHarness();
	await available.start();
	assert.deepEqual(available.activeTools(), ["read", "custom", "lsp_diagnostics", "lsp_fix"]);

	process.env.PI_LSP_CONFIG = '{"servers":{}}';
	const invalid = extensionHarness();
	await assert.rejects(async () => invalid.start(), /LSP config contains no servers/u);
	assert.deepEqual(invalid.activeTools(), ["read", "custom"]);
});
