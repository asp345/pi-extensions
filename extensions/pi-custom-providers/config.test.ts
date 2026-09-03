import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCustomProvidersFile, removeModelsStoreProviders, writeCustomProvidersFile } from "./config.ts";

async function withTempFile(run: (path: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-custom-providers-"));
	try {
		await run(join(directory, "custom-providers.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("a missing file reads as an empty provider set", async () => {
	await withTempFile(async (path) => {
		assert.deepEqual(await readCustomProvidersFile(path), { providers: {} });
	});
});

test("writes are atomic and private", async () => {
	await withTempFile(async (path) => {
		await writeCustomProvidersFile(
			{
				providers: {
					modal: {
						baseUrl: "https://example.modal.direct/v1",
						api: "openai-completions",
						compat: { supportsDeveloperRole: false },
					},
				},
			},
			path,
		);

		assert.deepEqual(await readdir(join(path, "..")), ["custom-providers.json"]);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
		assert.equal((await readCustomProvidersFile(path)).providers.modal?.baseUrl, "https://example.modal.direct/v1");
	});
});

test("unrelated custom-providers.json keys survive a rewrite", async () => {
	await withTempFile(async (path) => {
		await writeFile(path, JSON.stringify({ providers: {}, somethingElse: { keep: true } }));
		const data = await readCustomProvidersFile(path);
		await writeCustomProvidersFile(data, path);
		const raw = JSON.parse(await readFile(path, "utf8")) as { somethingElse?: unknown };
		assert.deepEqual(raw.somethingElse, { keep: true });
	});
});

test("malformed configuration fails loudly instead of silently resetting", async () => {
	await withTempFile(async (path) => {
		await writeFile(path, "{ not json");
		await assert.rejects(readCustomProvidersFile(path));

		await writeFile(path, JSON.stringify({ providers: [] }));
		await assert.rejects(readCustomProvidersFile(path), /providers/u);
	});
});

test("removeModelsStoreProviders removes only the requested provider catalogs", async () => {
	await withTempFile(async (path) => {
		await writeFile(
			path,
			JSON.stringify({
				removed: { models: [], checkedAt: 1 },
				unrelated: { models: [], checkedAt: 2 },
			}),
		);

		assert.deepEqual(await removeModelsStoreProviders(new Set(["removed"]), path), ["removed"]);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			unrelated: { models: [], checkedAt: 2 },
		});
	});
});

test("removeModelsStoreProviders is a no-op for empty, missing, and unreadable stores", async () => {
	await withTempFile(async (path) => {
		assert.deepEqual(await removeModelsStoreProviders(new Set(), path), []);
		assert.deepEqual(await removeModelsStoreProviders(new Set(["a"]), path), []);

		await writeFile(path, "{{{ broken");
		assert.deepEqual(await removeModelsStoreProviders(new Set(["a"]), path), []);
	});
});
