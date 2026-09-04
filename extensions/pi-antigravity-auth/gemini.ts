import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { toGeminiSchema } from "./agy/index.ts";

type GeminiPart =
	| { text: string; thought?: boolean; thoughtSignature?: string }
	| { inlineData: { mimeType: string; data: string } }
	| {
			functionCall: { name: string; args: Record<string, unknown>; id: string };
			thoughtSignature?: string;
	  }
	| {
			functionResponse: {
				name: string;
				response: Record<string, unknown>;
				id: string;
			};
	  };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiRequest = {
	contents: GeminiContent[];
	tools?: Array<{
		functionDeclarations: Array<{
			name: string;
			description: string;
			parameters?: unknown;
		}>;
	}>;
	systemInstruction?: { parts: GeminiPart[] };
};
export type GeminiResponsePart = {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		name?: string;
		args?: Record<string, unknown>;
		id?: string;
	};
};
export type GeminiChunk = {
	candidates?: Array<{
		content?: { parts?: GeminiResponsePart[] };
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		cachedContentTokenCount?: number;
		thoughtsTokenCount?: number;
	};
};

function userParts(content: Array<TextContent | ImageContent>): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push({ text: block.text.toWellFormed() });
		} else if (block.type === "image" && block.data) {
			parts.push({
				inlineData: { mimeType: block.mimeType, data: block.data },
			});
		}
	}
	return parts;
}

function assistantParts(message: AssistantMessage, preserveSignatures: boolean): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (preserveSignatures && block.thinking) {
				parts.push({
					text: block.thinking.toWellFormed(),
					thought: true,
					...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
				});
			}
		} else if (block.type === "text" && block.text.trim()) {
			parts.push({
				text: block.text.toWellFormed(),
				...(preserveSignatures && block.textSignature ? { thoughtSignature: block.textSignature } : {}),
			});
		} else if (block.type === "toolCall") {
			parts.push({
				functionCall: {
					name: block.name,
					args: block.arguments ?? {},
					id: block.id,
				},
				...(preserveSignatures && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
			});
		}
	}
	return parts;
}

function resultResponse(message: ToolResultMessage): Record<string, unknown> {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return message.isError ? { error: text || "Error" } : { output: text };
}

export function convertMessages(messages: Message[], target: Model<Api>): GeminiContent[] {
	const output: GeminiContent[] = [];
	const targetCalls = new Map<string, boolean>();
	const isTarget = (message: AssistantMessage) => message.provider === target.provider && message.model === target.id;

	for (const message of messages) {
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") targetCalls.set(block.id, isTarget(message));
		}
	}

	for (const message of messages) {
		if (!message) continue;
		if (message.role === "user") {
			const parts =
				typeof message.content === "string"
					? message.content.trim()
						? [{ text: message.content.toWellFormed() }]
						: []
					: userParts(message.content);
			if (parts.length) output.push({ role: "user", parts });
		} else if (message.role === "assistant") {
			const parts = assistantParts(message, isTarget(message));
			if (parts.length) output.push({ role: "model", parts });
		} else if (message.role === "toolResult") {
			const role = targetCalls.get(message.toolCallId) === true ? "user" : "model";
			const part: GeminiPart = {
				functionResponse: {
					name: message.toolName,
					response: resultResponse(message),
					id: message.toolCallId,
				},
			};
			const last = output.at(-1);
			if (last?.role === role && last.parts.every((item) => "functionResponse" in item)) {
				last.parts.push(part);
			} else {
				output.push({ role, parts: [part] });
			}
		}
	}
	return output;
}

export function geminiRequest(context: Context, model: Model<Api>): GeminiRequest {
	return {
		contents: convertMessages(context.messages, model),
		...(context.tools?.length
			? {
					tools: [
						{
							functionDeclarations: context.tools.map((tool) => ({
								name: tool.name,
								description: tool.description,
								parameters: toGeminiSchema(tool.parameters),
							})),
						},
					],
				}
			: {}),
		...(context.systemPrompt?.trim()
			? { systemInstruction: { parts: [{ text: context.systemPrompt.toWellFormed() }] } }
			: {}),
	};
}
