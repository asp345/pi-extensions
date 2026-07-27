import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fetchRemote, type Lookup } from "./security.ts";

async function server() {
	const hosts: string[] = [];
	let port = 0;
	const instance = createServer((request, response) => {
		hosts.push(request.headers.host ?? "");
		if (request.url === "/redirect") {
			response.writeHead(302, { location: `http://next.invalid:${port}/final` });
			response.end();
			return;
		}
		if (request.url === "/blocked") {
			response.writeHead(302, { location: "http://private.invalid/final" });
			response.end();
			return;
		}
		response.end("pinned-ok");
	});
	await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
	const address = instance.address();
	if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
	port = address.port;
	return { instance, hosts, port };
}

test("pins validated DNS results for requests and redirects", async (context) => {
	const { instance, hosts, port } = await server();
	context.after(() => instance.close());
	const resolved: string[] = [];
	const lookup: Lookup = async (hostname) => {
		resolved.push(hostname);
		return [{ address: "127.0.0.1", family: 4 }];
	};
	const response = await fetchRemote(
		`http://first.invalid:${port}/redirect`,
		{},
		{
			lookup,
			allowRanges: ["127.0.0.0/8"],
		},
	);
	assert.equal(await response.text(), "pinned-ok");
	assert.deepEqual(resolved, ["first.invalid", "next.invalid"]);
	assert.deepEqual(hosts, [`first.invalid:${port}`, `next.invalid:${port}`]);
});

test("rejects a redirect that resolves to an internal address", async (context) => {
	const { instance, port } = await server();
	context.after(() => instance.close());
	const lookup: Lookup = async (hostname) => [
		{ address: hostname === "private.invalid" ? "10.0.0.1" : "127.0.0.1", family: 4 },
	];
	await assert.rejects(
		fetchRemote(`http://first.invalid:${port}/blocked`, {}, { lookup, allowRanges: ["127.0.0.0/8"] }),
		/Blocked internal address/u,
	);
});
