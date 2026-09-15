/**
 * compact-ui: one line per built-in tool call, no grouping.
 *
 * Built-in tools (read, bash, edit, write, find, grep, ls) are re-registered
 * with a one-line call renderer and execution delegated to the native per-cwd
 * definitions. Collapsed results render nothing; expanded (Ctrl+O) results
 * delegate to the native renderer. Thinking and everything else render
 * natively; this extension owns no transcript state.
 */

import { homedir } from "node:os";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";

const PENDING_ICON = "◌";

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown, max = 60): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function argString(args: unknown, key: string): string {
	if (typeof args !== "object" || args === null) return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function toolSummary(name: string, args: unknown): { name: string; content: string } {
	switch (name) {
		case "bash":
			return { name: "bash", content: oneLine(argString(args, "command") || "…") };
		case "read":
			return { name: "read", content: shortenPath(argString(args, "path") || "…") };
		case "write":
		case "edit":
			return { name, content: shortenPath(argString(args, "path") || "…") };
		case "find":
			return {
				name: "find",
				content: `${oneLine(argString(args, "pattern"))} in ${shortenPath(argString(args, "path") || ".")}`,
			};
		case "grep":
			return {
				name: "grep",
				content: `${oneLine(argString(args, "pattern"))} in ${shortenPath(argString(args, "path") || ".")}`,
			};
		case "ls":
			return { name: "ls", content: shortenPath(argString(args, "path") || ".") };
		default: {
			const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
			const preferred = record?.path ?? record?.query ?? record?.name ?? record?.description ?? record?.url;
			return { name, content: oneLine(preferred ?? "…") };
		}
	}
}

type ToolName = "read" | "bash" | "edit" | "write" | "find" | "grep" | "ls";
type NativeToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

function eraseToolType(tool: object): NativeToolDefinition {
	return tool as NativeToolDefinition;
}

const toolCache = new Map<string, Record<ToolName, NativeToolDefinition>>();

function getTools(cwd: string): Record<ToolName, NativeToolDefinition> {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = {
			read: eraseToolType(createReadToolDefinition(cwd)),
			bash: eraseToolType(createBashToolDefinition(cwd)),
			edit: eraseToolType(createEditToolDefinition(cwd)),
			write: eraseToolType(createWriteToolDefinition(cwd)),
			find: eraseToolType(createFindToolDefinition(cwd)),
			grep: eraseToolType(createGrepToolDefinition(cwd)),
			ls: eraseToolType(createLsToolDefinition(cwd)),
		};
		toolCache.set(cwd, tools);
	}
	return tools;
}

export interface CompactCallStatus {
	isPartial: boolean;
	isError: boolean;
}

export function compactCallLine(name: string, args: unknown, theme: Theme, status: CompactCallStatus): Component {
	const done = !status.isPartial;
	const color: ThemeColor = status.isError ? "error" : done ? "success" : "accent";
	const icon = status.isError ? "✗" : done ? "✓" : PENDING_ICON;
	const summary = toolSummary(name, args);
	return new Text(
		`${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(summary.name))} ${theme.fg("dim", summary.content)}`,
		0,
		0,
	);
}

interface RenderCallContext {
	cwd: string;
	executionStarted: boolean;
	isPartial: boolean;
	isError: boolean;
}

function renderCallOneLine(name: ToolName, args: unknown, theme: Theme, context: RenderCallContext): Component {
	return compactCallLine(name, args, theme, context);
}

function wrapRenderCall(name: ToolName): NonNullable<NativeToolDefinition["renderCall"]> {
	const render = (args: unknown, theme: Theme, context: RenderCallContext): Component =>
		renderCallOneLine(name, args, theme, context);
	return render as NonNullable<NativeToolDefinition["renderCall"]>;
}

function wrapRenderResult(name: ToolName): NonNullable<NativeToolDefinition["renderResult"]> {
	const render = (
		result: unknown,
		options: { expanded: boolean },
		theme: Theme,
		context: { cwd: string },
	): Component => {
		if (!options.expanded) return new Container();
		const native = getTools(context.cwd)[name].renderResult;
		if (typeof native === "function") {
			return (
				native as (
					callResult: unknown,
					callOptions: unknown,
					callTheme: Theme,
					callContext: { cwd: string },
				) => Component
			)(result, options, theme, context);
		}
		return new Container();
	};
	return render as NonNullable<NativeToolDefinition["renderResult"]>;
}

export default function (pi: ExtensionAPI) {
	const delegate =
		(name: ToolName) =>
		async (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			return getTools(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate, ctx);
		};

	for (const name of ["read", "bash", "edit", "write", "find", "grep", "ls"] as const) {
		pi.registerTool({
			...getTools(process.cwd())[name],
			execute: delegate(name),
			renderCall: wrapRenderCall(name),
			renderResult: wrapRenderResult(name),
			renderShell: "self",
		});
	}
}
