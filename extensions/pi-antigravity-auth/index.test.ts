import assert from "node:assert/strict";
import { test } from "node:test";
import { convertMessages, parseSse, requestSessionKey, resolveModel } from "./index.ts";
import { modelThinkingLevelMap } from "./model-resolver.ts";
import { STATIC_MODEL_CATALOG } from "./models.ts";

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

test("tool results use the user role for Claude targets and the model role otherwise", () => {
	const messages = [
		{
			role: "assistant",
			provider: "antigravity",
			model: "claude-opus-5-5",
			content: [{ type: "toolCall", id: "claude", name: "read", arguments: {} }],
		},
		{ role: "toolResult", toolCallId: "claude", toolName: "read", content: [], isError: false },
		{
			role: "assistant",
			provider: "antigravity",
			model: "gemini-3.8-flash",
			content: [{ type: "toolCall", id: "gemini", name: "read", arguments: {} }],
		},
		{ role: "toolResult", toolCallId: "gemini", toolName: "read", content: [], isError: false },
	] as Parameters<typeof convertMessages>[0];
	const roles = (id: string) =>
		convertMessages(messages, { provider: "antigravity", id } as Parameters<typeof convertMessages>[1])
			.filter((content) => "functionResponse" in content.parts[0])
			.map((content) => content.role);

	assert.deepEqual(roles("claude-opus-5-5"), ["user", "user"]);
	assert.deepEqual(roles("gemini-3.8-flash"), ["model", "model"]);
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

test("resolveModel reads the tier stored in the thinking level map", () => {
	const model = (id: string) => {
		const definition = STATIC_MODEL_CATALOG.find((candidate) => candidate.id === id);
		assert.ok(definition);
		return {
			provider: "antigravity",
			id,
			api: "google-generative-ai",
			reasoning: true,
			thinkingLevelMap: modelThinkingLevelMap(definition),
		} as Parameters<typeof resolveModel>[0];
	};
	const gemini = model("gemini-3.7-flash");

	assert.deepEqual(resolveModel(gemini, "low"), {
		wireModel: "gemini-3.7-flash-low",
		modelEnum: "MODEL_PLACEHOLDER_M300",
		thinkingBudget: 1000,
	});
	assert.equal(resolveModel(gemini, "xhigh").wireModel, "gemini-3.7-flash-medium");
	assert.deepEqual(resolveModel(model("claude-opus-5-5"), "high"), {
		wireModel: "claude-opus-5-5-high",
		modelEnum: "MODEL_PLACEHOLDER_M402",
		thinkingBudget: 0,
		thinkingLevel: "HIGH",
	});
	assert.equal(resolveModel(model("gemini-3.1-pro"), "high").wireModel, "gemini-pro-agent");
	assert.equal(resolveModel(model("gemini-3.1-pro"), undefined).wireModel, "gemini-3.1-pro-low");
});
