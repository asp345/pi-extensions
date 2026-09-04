import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.ts";

export const RESULT_BYTES = 8_000;
const RESULT_LINES = 120;

export interface CompletionDetails {
	id: string;
	type: string;
	status: string;
	turns: number;
	toolUses: number;
	durationMs: number;
	usedFallback?: boolean;
}

export function foregroundResult(record: AgentRecord): AgentToolResult<Record<string, unknown>> {
	if (record.status === "error") throw new Error(record.error || `${record.type} failed.`);
	if (record.status === "stopped") throw new Error(`${record.type} was stopped.`);
	const page = bounded(record.result || "No final answer.", RESULT_BYTES, RESULT_LINES);
	const suffix = page.truncated
		? `\n\n[Final answer truncated; use get_subagent_result with id ${record.id} for bounded pages.]`
		: "";
	return result(page.text + suffix, metadata(record));
}

export function result(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

export function metadata(record: AgentRecord): Record<string, unknown> {
	return {
		...completionDetails(record),
		background: record.background,
		model: record.session?.model ? `${record.session.model.provider}/${record.session.model.id}` : record.model,
		models: record.models,
		usedFallback: record.usedFallback === true,
		fallbackReason: record.fallbackReason,
		worktreeBranch: record.worktreeBranch,
	};
}

export function completionDetails(record: AgentRecord): CompletionDetails {
	return {
		id: record.id,
		type: record.type,
		status: record.status,
		turns: record.turns,
		toolUses: record.toolUses,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		usedFallback: record.usedFallback,
	};
}

export function formatMetadata(record: AgentRecord): string {
	return [
		`ID: ${record.id}`,
		`Type: ${record.type}`,
		`Title: ${record.title}`,
		`Status: ${record.status}`,
		`Turns: ${record.turns}`,
		`Tool uses: ${record.toolUses}`,
		record.usedFallback ? `Fallback model: ${record.model ?? "active"}` : "",
		record.fallbackReason ? `Fallback reason: ${bounded(record.fallbackReason, 1_000, 8).text}` : "",
		record.worktreeBranch ? `Worktree branch: ${record.worktreeBranch}` : "",
		record.error ? `Error: ${bounded(record.error, 1_000, 8).text}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

export function pageText(value: string, offset: number, limit: number) {
	const bytes = Buffer.from(value, "utf8");
	const start = Math.min(offset, bytes.length);
	const end = Math.min(bytes.length, start + limit);
	let text = bytes.subarray(start, end).toString("utf8");
	if (text.endsWith("�") && end < bytes.length) text = text.slice(0, -1);
	text = text.split("\n").slice(0, RESULT_LINES).join("\n");
	const consumed = Buffer.byteLength(text, "utf8");
	return {
		text,
		offset: start,
		totalBytes: bytes.length,
		nextOffset: start + consumed < bytes.length ? start + consumed : null,
	};
}

export function bounded(value: string, maxBytes: number, maxLines: number): { text: string; truncated: boolean } {
	const lines = value.split("\n");
	let text = lines.slice(0, maxLines).join("\n");
	let truncated = lines.length > maxLines;
	let bytes = Buffer.from(text, "utf8");
	if (bytes.length > maxBytes) {
		bytes = bytes.subarray(0, maxBytes);
		text = bytes.toString("utf8").replace(/�$/u, "");
		truncated = true;
	}
	return { text, truncated };
}
