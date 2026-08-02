import assert from "node:assert/strict";
import { test } from "node:test";
import { convertMessages, parseSse, requestSessionKey } from "./index.ts";

const encoder = new TextEncoder();

function responseFrom(parts: string[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(encoder.encode(part));
				controller.close();
			},
		}),
	);
}

async function collect(response: Response): Promise<unknown[]> {
	const chunks: unknown[] = [];
	for await (const chunk of parseSse(response)) chunks.push(chunk);
	return chunks;
}

test("tool results use Antigravity's observed same-model and cross-model roles", () => {
	const target = { provider: "google-antigravity", id: "claude-opus" } as Parameters<typeof convertMessages>[1];
	const messages = [
		{
			role: "assistant",
			provider: "google-antigravity",
			model: "claude-opus",
			content: [{ type: "toolCall", id: "same", name: "read", arguments: {} }],
		},
		{ role: "toolResult", toolCallId: "same", toolName: "read", content: [], isError: false },
		{
			role: "assistant",
			provider: "google-antigravity",
			model: "gemini-flash",
			content: [{ type: "toolCall", id: "cross", name: "read", arguments: {} }],
		},
		{ role: "toolResult", toolCallId: "cross", toolName: "read", content: [], isError: false },
	] as Parameters<typeof convertMessages>[0];

	const converted = convertMessages(messages, target);
	assert.equal(
		converted.find(
			(content) => "functionResponse" in content.parts[0] && content.parts[0].functionResponse.id === "same",
		)?.role,
		"user",
	);
	assert.equal(
		converted.find(
			(content) => "functionResponse" in content.parts[0] && content.parts[0].functionResponse.id === "cross",
		)?.role,
		"model",
	);
});

test("request sessions are scoped by credential without exposing it", () => {
	const first = requestSessionKey("session", "account-one-refresh-token");
	const second = requestSessionKey("session", "account-two-refresh-token");
	assert.notEqual(first, second);
	assert.equal(first, requestSessionKey("session", "account-one-refresh-token"));
	assert.ok(!first.includes("account-one"));
});

test("SSE frames parse across every byte boundary", async () => {
	const source = 'data: {"candidates":[]}\r\n\r\ndata: {"usageMetadata":{"promptTokenCount":1}}\r\n\r\n';
	const expected = [{ candidates: [] }, { usageMetadata: { promptTokenCount: 1 } }];
	for (let split = 1; split < source.length; split += 1) {
		assert.deepEqual(await collect(responseFrom([source.slice(0, split), source.slice(split)])), expected);
	}
});

test("SSE joins multiline data and rejects in-band errors", async () => {
	assert.deepEqual(await collect(responseFrom(['data: {"candidates":\n', "data: []}\n\n"])), [{ candidates: [] }]);
	await assert.rejects(
		async () => collect(responseFrom(['data: {"error":{"message":"quota exceeded"}}\n\n'])),
		/Antigravity stream error: quota exceeded/u,
	);
	await assert.rejects(
		async () => collect(responseFrom(['event: error\ndata: {"message":"failed"}\n\n'])),
		/Antigravity stream error/u,
	);
});
