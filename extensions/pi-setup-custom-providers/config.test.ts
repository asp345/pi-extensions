import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneModelsStore, readModelsFile, writeModelsFile } from "./config.ts";

async function withTempFile(run: (path: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-custom-model-"));
	try {
		await run(join(directory, "models.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("a missing file reads as an empty provider set", async () => {
	await withTempFile(async (path) => {
		assert.deepEqual(await readModelsFile(path), { providers: {} });
	});
});

test("writes are atomic, private, and preserve per-model thinking settings", async () => {
	await withTempFile(async (path) => {
		await writeModelsFile(
			{
				providers: {
					modal: {
						baseUrl: "https://example.modal.direct/v1",
						api: "openai-completions",
						models: [
							{
								id: "moonshotai/Kimi-K3",
								reasoning: true,
								thinkingLevelMap: { high: "high", max: "max" },
								limitSource: "manual",
							},
						],
					},
				},
			},
			path,
		);

		const directory = join(path, "..");
		assert.deepEqual(await readdir(directory), ["models.json"]);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);

		const model = (await readModelsFile(path)).providers.modal?.models?.[0];
		assert.equal(model?.reasoning, true);
		assert.deepEqual(model?.thinkingLevelMap, { high: "high", max: "max" });
		assert.equal(model?.limitSource, "manual");
	});
});

test("unrelated models.json keys survive a rewrite", async () => {
	await withTempFile(async (path) => {
		await writeFile(path, JSON.stringify({ providers: {}, somethingElse: { keep: true } }));
		const data = await readModelsFile(path);
		await writeModelsFile(data, path);
		const raw = JSON.parse(await readFile(path, "utf8")) as { somethingElse?: unknown };
		assert.deepEqual(raw.somethingElse, { keep: true });
	});
});

test("malformed configuration fails loudly instead of silently resetting", async () => {
	await withTempFile(async (path) => {
		await writeFile(path, "{ not json");
		await assert.rejects(readModelsFile(path));

		await writeFile(path, JSON.stringify({ providers: [] }));
		await assert.rejects(readModelsFile(path), /providers/u);
	});
});

test("pruneModelsStore removes entries outside the live set and leaves the rest", async () => {
	await withTempFile(async (path) => {
		await writeFile(
			path,
			JSON.stringify({
				keep_configured: { models: [], checkedAt: 1 },
				keep_builtin: { models: [], checkedAt: 2 },
				orphan: { models: [], checkedAt: 3 },
			}),
		);

		const removed = await pruneModelsStore(new Set(["keep_configured", "keep_builtin"]), path);
		assert.deepEqual(removed, ["orphan"]);
		const remaining = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.deepEqual(Object.keys(remaining).sort(), ["keep_builtin", "keep_configured"]);
	});
});

test("pruneModelsStore is a no-op on missing, alive-only, and unreadable files", async () => {
	await withTempFile(async (path) => {
		assert.deepEqual(await pruneModelsStore(new Set(["a"]), path), []);

		await writeFile(path, JSON.stringify({ a: { models: [], checkedAt: 9 } }));
		assert.deepEqual(await pruneModelsStore(new Set(["a"]), path), []);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { a: { models: [], checkedAt: 9 } });

		await writeFile(path, "{{{ broken");
		assert.deepEqual(await pruneModelsStore(new Set(["a"]), path), []);
	});
});
