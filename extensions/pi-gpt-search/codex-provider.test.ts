import assert from "node:assert/strict";
import { test } from "node:test";

const { CodexWebSearchProvider } = await import("./codex-provider.ts");

function providerWithResponses(bodies: unknown[], statuses = bodies.map(() => 200)) {
	const responses = bodies.map((body, i) => {
		const status = statuses[i] ?? 200;
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => body,
			text: async () => JSON.stringify(body),
		};
	});
	let call = 0;
	const requests: Array<{ headers: Record<string, string>; body: string }> = [];
	const customFetch: typeof fetch = async (_url, init) => {
		requests.push({
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: (init?.body ?? "") as string,
		});
		return responses[Math.min(call++, responses.length - 1)] as unknown as Response;
	};
	return { provider: new CodexWebSearchProvider({ customFetch, sessionId: "s1" }), requests };
}

const stubCtx = { modelRegistry: { getProviderAuth: async () => undefined } } as never;

test("recordRefs accumulates ref metadata across responses within one session", async () => {
	const { provider } = providerWithResponses([
		{ results: [{ ref_id: "turn0search0", url: "https://a.io", title: "A" }] },
		{ results: [{ ref_id: "turn1view0", url: "https://b.io" }] },
	]);

	await provider.execute({ search_query: [{ q: "a" }] }, undefined, stubCtx);
	await provider.execute({ open: [{ ref_id: "turn0search0" }] }, undefined, stubCtx);

	const index = provider.getRefIndex();
	assert.deepEqual(index.get("turn0search0"), { url: "https://a.io", title: "A" });
	assert.deepEqual(index.get("turn1view0"), { url: "https://b.io", title: undefined });
	assert.equal(index.size, 2);
});

test("recordRefs keeps the existing title when a later response omits it", async () => {
	const { provider } = providerWithResponses([
		{ results: [{ ref_id: "turn0search0", url: "https://a.io", title: "A" }] },
		{ results: [{ ref_id: "turn0search0", url: "https://a.io" }] },
	]);

	await provider.execute({ search_query: [{ q: "a" }] }, undefined, stubCtx);
	await provider.execute({ open: [{ ref_id: "turn0search0" }] }, undefined, stubCtx);

	assert.deepEqual(provider.getRefIndex().get("turn0search0"), { url: "https://a.io", title: "A" });
});

test("recordRefs ignores results without ref_id or url", async () => {
	const { provider } = providerWithResponses([
		{ results: [{ title: "no ref" }, { ref_id: "turn0search1" }, { ref_id: "turn0search2", url: "https://c.io" }] },
	]);

	await provider.execute({ search_query: [{ q: "c" }] }, undefined, stubCtx);

	const index = provider.getRefIndex();
	assert.equal(index.size, 1);
	assert.equal(index.get("turn0search2")?.url, "https://c.io");
});

test("setSessionId clears the ref index only when the id changes", async () => {
	const { provider } = providerWithResponses([{ results: [{ ref_id: "turn0search0", url: "https://a.io" }] }]);

	await provider.execute({ search_query: [{ q: "a" }] }, undefined, stubCtx);
	provider.setSessionId("s1");
	assert.equal(provider.getRefIndex().size, 1);
	provider.setSessionId("s2");
	assert.equal(provider.getRefIndex().size, 0);
	assert.equal(provider.getSessionId(), "s2");
});

test("execute sends session id, model, and serialized commands in the payload", async () => {
	const { provider, requests } = providerWithResponses([{ results: [] }]);
	provider.getRefIndex().set("turn0search0", { url: "https://a.io" });

	await provider.execute({ find: [{ ref_id: "turn0search0", pattern: "x" }] }, undefined, stubCtx);

	const body = JSON.parse(requests[0].body);
	assert.equal(body.id, "s1");
	assert.equal(body.model, "gpt-4o");
	assert.deepEqual(body.commands, { find: [{ ref_id: "turn0search0", pattern: "x" }] });
	assert.equal(requests[0].headers["Content-Type"], "application/json");
});

test("open and find fail fast with guidance when a reference is stale", async () => {
	const { provider } = providerWithResponses([{ results: [] }]);

	await assert.rejects(
		provider.execute({ open: [{ ref_id: "turn9search9" }] }, undefined, stubCtx),
		/Unknown or stale reference "turn9search9"/u,
	);
	await assert.rejects(
		provider.execute({ find: [{ ref_id: "turn9view0", pattern: "x" }] }, undefined, stubCtx),
		/Unknown or stale reference "turn9view0"/u,
	);

	const indexed = providerWithResponses([{ results: [{ ref_id: "turn0search0", url: "https://a.io" }] }]);
	await indexed.provider.execute({ search_query: [{ q: "a" }] }, undefined, stubCtx);
	const response = await indexed.provider.execute({ open: [{ ref_id: "turn0search0" }] }, undefined, stubCtx);
	assert.ok(Array.isArray(response.results));
});
