import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./routing.ts";

test("untrusted projects cannot supply LSP commands", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-trust-"));
	const root = join(directory, "project");
	const agentDir = join(directory, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	});
	await mkdir(join(root, CONFIG_DIR_NAME), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(root, CONFIG_DIR_NAME, "pi-lsp.json"),
		JSON.stringify({ project: { command: ["project-command"], extensions: ["ts"] } }),
	);
	await writeFile(
		join(agentDir, "pi-lsp.json"),
		JSON.stringify({ user: { command: ["user-command"], extensions: ["ts"] } }),
	);

	assert.equal(loadConfig(root, false).servers[0]?.name, "user");
	assert.equal(loadConfig(root, true).servers[0]?.name, "project");
});
