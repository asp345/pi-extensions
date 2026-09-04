import type { GeminiChunk } from "./gemini.ts";

function unwrapChunk(value: unknown): GeminiChunk {
	if (value && typeof value === "object" && "response" in value) {
		const response = (value as { response?: unknown }).response;
		if (response && typeof response === "object") return response as GeminiChunk;
	}
	return value as GeminiChunk;
}

function payloadError(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || !("error" in value)) return undefined;
	const error = (value as { error?: unknown }).error;
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return JSON.stringify(error).slice(0, 500);
}

export async function* parseSse(response: Response): AsyncGenerator<GeminiChunk> {
	if (!response.body) throw new Error("Antigravity stream returned no response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parseFrame = (frame: string): GeminiChunk | undefined => {
		const lines = frame.split(/\r\n|\r|\n/u);
		const event = lines
			.find((line) => line.startsWith("event:"))
			?.slice(6)
			.trim();
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /u, ""))
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new Error(`Antigravity stream returned malformed SSE data: ${data.slice(0, 500)}`);
		}
		const chunk = unwrapChunk(parsed);
		const error = payloadError(parsed) ?? payloadError(chunk);
		if (event === "error" || error) throw new Error(`Antigravity stream error: ${error ?? data.slice(0, 500)}`);
		return chunk;
	};
	const nextBoundary = () => /(?:\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r)/u.exec(buffer);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = nextBoundary();
			while (boundary?.index !== undefined) {
				const chunk = parseFrame(buffer.slice(0, boundary.index));
				if (chunk) yield chunk;
				buffer = buffer.slice(boundary.index + boundary[0].length);
				boundary = nextBoundary();
			}
		}
		buffer += decoder.decode();
		const chunk = buffer.trim() ? parseFrame(buffer) : undefined;
		if (chunk) yield chunk;
	} finally {
		reader.releaseLock();
	}
}
