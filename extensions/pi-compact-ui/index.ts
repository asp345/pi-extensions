/**
 * compact-ui: one line per built-in tool call, no grouping.
 *
 * Built-in tools (read, edit, write, find, grep, ls) are re-registered
 * with a one-line call renderer and execution delegated to the native per-cwd
 * definitions. Collapsed results render nothing except for edit and write,
 * which share a syntax highlighted code block; expanded (Ctrl+O) results show
 * the full output. Thinking and everything else render natively; this extension
 * owns no transcript state.
 */

import { homedir } from "node:os";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	type Theme,
	type ThemeColor,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Container, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PENDING_ICON = "◌";
const ELLIPSIS = "…";
const MIN_NUMBER_WIDTH = 3;
/** Kept empty at the right edge so a truncated line does not touch the viewport border. */
const RIGHT_MARGIN = 1;
const ALWAYS_RENDERED_RESULTS: ReadonlySet<ToolName> = new Set(["edit", "write"]);
const PREVIEW_LINES = 30;

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function argString(args: unknown, key: string): string {
	if (typeof args !== "object" || args === null) return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function webSummary(args: unknown): string {
	if (typeof args !== "object" || args === null) return "…";
	const cmd = args as Record<string, unknown>;
	const parts: string[] = [];
	const queries = asRecordArray(cmd.search_query)
		.map((item) => `"${oneLine(item.q ?? "")}"`)
		.filter((text) => text.length > 2);
	if (queries.length > 0) parts.push(queries.join(", "));
	for (const item of asRecordArray(cmd.open)) {
		if (typeof item.ref_id === "string" && item.ref_id) parts.push(`open ${item.ref_id}`);
	}
	for (const item of asRecordArray(cmd.find)) {
		const ref = typeof item.ref_id === "string" ? item.ref_id : "";
		const pattern = typeof item.pattern === "string" ? oneLine(item.pattern) : "";
		if (pattern && ref) parts.push(`find "${pattern}" in ${ref}`);
		else if (ref) parts.push(`find in ${ref}`);
	}
	for (const item of asRecordArray(cmd.click)) {
		const ref = typeof item.ref_id === "string" ? item.ref_id : "";
		if (!ref) continue;
		parts.push(typeof item.id === "number" ? `click #${item.id} in ${ref}` : `click in ${ref}`);
	}
	if (parts.length === 0) return "…";
	return oneLine(parts.join("; "));
}

function launchSubagentSummary(args: unknown): string {
	if (typeof args !== "object" || args === null) return "…";
	const cmd = args as Record<string, unknown>;
	const type = typeof cmd.subagent_type === "string" ? cmd.subagent_type : "";
	const title = typeof cmd.title === "string" ? oneLine(cmd.title) : "";
	if (type && title) return oneLine(`${type} ${title}`);
	return oneLine(type || title || "…");
}

function backgroundTaskSummary(args: unknown): string {
	if (typeof args !== "object" || args === null) return "…";
	const cmd = args as Record<string, unknown>;
	const action = typeof cmd.action === "string" ? cmd.action : "";
	if (!action) return "…";
	if (action === "start") {
		const command = typeof cmd.command === "string" ? oneLine(cmd.command) : "";
		return command ? `start ${command}` : "start";
	}
	if (action === "read" || action === "stop") {
		const id = typeof cmd.id === "string" ? cmd.id : "";
		return id ? `${action} ${id}` : action;
	}
	return action;
}

export function toolSummary(name: string, args: unknown): CompactSummary {
	switch (name) {
		case "launch_subagent":
			return { name: "launch_subagent", content: launchSubagentSummary(args) };
		case "background_task":
			return { name: "background_task", content: backgroundTaskSummary(args) };
		case "web":
			return { name: "web", content: webSummary(args) };
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

type ToolName = "read" | "edit" | "write" | "find" | "grep" | "ls";
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

export interface CompactSummary {
	name: string;
	content: string;
	suffix?: string;
}

class CompactLine implements Component {
	constructor(
		private readonly head: string,
		private readonly content: string,
		private readonly suffix: string,
		private readonly dim: (text: string) => string,
	) {}

	render(width: number): string[] {
		const available = width - visibleWidth(this.head) - visibleWidth(this.suffix) - RIGHT_MARGIN;
		if (available <= 0) return [this.fit(this.head, width - RIGHT_MARGIN, (text) => text)];
		return [`${this.head}${this.fit(this.content, available, this.dim)}${this.dim(this.suffix)}`];
	}

	/**
	 * `truncateToWidth` resets the style before appending its ellipsis, so the ellipsis is emitted
	 * separately through `style`; the truncated text keeps all but the last column for it.
	 */
	private fit(text: string, maxWidth: number, style: (text: string) => string): string {
		if (maxWidth <= 0) return "";
		if (visibleWidth(text) <= maxWidth) return style(text);
		return `${style(truncateToWidth(text, maxWidth - 1, ""))}${this.dim(ELLIPSIS)}`;
	}

	invalidate(): void {}
}

export function compactCallLine(
	name: string,
	args: unknown,
	theme: Theme,
	status: CompactCallStatus,
	override?: CompactSummary,
): Component {
	const done = !status.isPartial;
	const color: ThemeColor = status.isError ? "error" : done ? "success" : "accent";
	const icon = status.isError ? "✗" : done ? "✓" : PENDING_ICON;
	const summary = override ?? toolSummary(name, args);
	const head = ` ${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(summary.name))} `;
	const suffix = summary.suffix ? ` ${summary.suffix}` : "";
	return new CompactLine(head, summary.content, suffix, (text) => theme.fg("dim", text));
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

interface RenderResultContext {
	cwd: string;
	args: unknown;
	isError: boolean;
	lastComponent?: Component;
}

type CodeLineKind = "added" | "removed" | "context";

interface CodeLine {
	kind: CodeLineKind;
	sign: string;
	number: string;
	code: string;
	codeColor?: ThemeColor;
}

const GUTTER_COLOR: Record<CodeLineKind, ThemeColor> = {
	added: "toolDiffAdded",
	removed: "toolDiffRemoved",
	context: "toolDiffContext",
};

function wrapCodeLine(prefix: string, code: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const codeWidth = visibleWidth(code);
	if (prefixWidth + codeWidth <= width) return [`${prefix}${code}`];
	if (width - prefixWidth < 1) {
		const full = `${prefix}${code}`;
		const total = visibleWidth(full);
		const out: string[] = [];
		let col = 0;
		const take = Math.max(1, width);
		while (col < total) {
			const chunk = sliceByColumn(full, col, take);
			const w = visibleWidth(chunk);
			if (w <= 0 || out.length > 1000) break;
			out.push(chunk);
			col += w;
		}
		return out.length > 0 ? out : [full];
	}
	const chunkWidth = width - prefixWidth;
	const indent = " ".repeat(prefixWidth);
	const out: string[] = [];
	let col = 0;
	let first = true;
	while (col < codeWidth) {
		const chunk = sliceByColumn(code, col, chunkWidth);
		const w = visibleWidth(chunk);
		if (w <= 0 || out.length > 1000) break;
		out.push(`${first ? prefix : indent}${chunk}`);
		col += w;
		first = false;
	}
	return out.length > 0 ? out : [`${prefix}${code}`];
}

class CodeBlock implements Component {
	constructor(
		private lines: CodeLine[],
		private hint: string,
		private theme: Theme,
	) {}

	setContent(lines: CodeLine[], hint: string, theme: Theme): void {
		this.lines = lines;
		this.hint = hint;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = (line: string) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const out: string[] = [];
		for (const line of this.lines) {
			const sign = this.theme.fg(GUTTER_COLOR[line.kind], line.sign);
			const number = this.theme.fg("thinkingText", ` ${line.number} `);
			const code = line.codeColor ? this.theme.fg(line.codeColor, line.code) : line.code;
			for (const wrapped of wrapCodeLine(`${sign}${number}`, code, width)) {
				const padded = pad(wrapped);
				if (line.kind === "added") out.push(this.theme.bg("toolSuccessBg", padded));
				else if (line.kind === "removed") out.push(this.theme.bg("toolErrorBg", padded));
				else out.push(padded);
			}
		}
		if (this.hint) {
			const first = this.lines[0];
			const indent = " ".repeat(first ? first.number.length + 3 : 0);
			for (const wrapped of wrapTextWithAnsi(this.hint, Math.max(1, width - indent.length)))
				out.push(pad(`${indent}${wrapped}`));
		}
		return out;
	}
}

function displayLines(codes: readonly string[]): string[] {
	return codes.map((code) => code.replace(/\r/gu, "").replace(/\t/gu, "   "));
}

function highlightLines(display: readonly string[], path: string): string[] {
	const lang = path ? getLanguageFromPath(path) : undefined;
	if (!lang) return [...display];
	const highlighted = highlightCode(display.join("\n"), lang);
	return display.map((code, index) => highlighted[index] ?? code);
}

function diffGutterWidth(lines: readonly string[]): number {
	for (const line of lines) {
		const match = /^[-+ ] *\d+ /.exec(line);
		if (match) return match[0].length;
	}
	return 0;
}

function diffCodeLines(diff: string, path: string): CodeLine[] {
	const lines = diff.split("\n");
	const gutterWidth = diffGutterWidth(lines);
	const display = displayLines(lines.map((line) => line.slice(gutterWidth)));
	const highlighted = highlightLines(display, path);
	let numberWidth = MIN_NUMBER_WIDTH;
	for (const line of lines) {
		const digits = /^[-+ ] *(\d+)/.exec(line)?.[1];
		if (digits) numberWidth = Math.max(numberWidth, digits.length);
	}
	return lines.map((line, index) => {
		const sign = line.slice(0, 1);
		const rawNumber = line.slice(1, Math.max(1, gutterWidth - 1));
		const digits = /\d/.test(rawNumber) ? rawNumber.trim() : "";
		const number = digits.padStart(numberWidth, " ");
		const plain = display[index] ?? "";
		if (!digits) return { kind: "context", sign, number, code: plain, codeColor: "muted" };
		if (sign === "-") return { kind: "removed", sign, number, code: plain, codeColor: "toolDiffRemoved" };
		return { kind: sign === "+" ? "added" : "context", sign, number, code: highlighted[index] ?? plain };
	});
}

function contentCodeLines(content: string, path: string): CodeLine[] {
	const raw = content.split("\n");
	while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
	const codes = highlightLines(displayLines(raw), path);
	const numberWidth = Math.max(MIN_NUMBER_WIDTH, String(raw.length).length);
	return raw.map((_line, index) => ({
		kind: "context",
		sign: " ",
		number: String(index + 1).padStart(numberWidth, " "),
		code: codes[index] ?? "",
	}));
}

function codeBlock(lines: CodeLine[], expanded: boolean, theme: Theme, previous: Component | undefined): Component {
	const shown = expanded ? lines.length : Math.min(lines.length, PREVIEW_LINES);
	const remaining = lines.length - shown;
	const hint =
		remaining > 0
			? `${theme.fg("muted", `... (${remaining} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
			: "";
	const block = previous instanceof CodeBlock ? previous : new CodeBlock([], "", theme);
	block.setContent(lines.slice(0, shown), hint, theme);
	return block;
}

type NativeRenderResult = (
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderResultContext,
) => Component;

function wrapRenderResult(name: ToolName): NonNullable<NativeToolDefinition["renderResult"]> {
	const render = (
		result: unknown,
		options: { expanded: boolean },
		theme: Theme,
		context: RenderResultContext,
	): Component => {
		if (!options.expanded && !ALWAYS_RENDERED_RESULTS.has(name)) return new Container();
		const previous = context.lastComponent;
		const path = argString(context.args, "path");
		if (!context.isError) {
			if (name === "edit") {
				const diff = (result as { details?: { diff?: unknown } }).details?.diff;
				if (typeof diff === "string" && diff)
					return codeBlock(diffCodeLines(diff, path), options.expanded, theme, previous);
			}
			if (name === "write") {
				const content = argString(context.args, "content");
				if (content) return codeBlock(contentCodeLines(content, path), options.expanded, theme, previous);
			}
		}
		const native = getTools(context.cwd)[name].renderResult as NativeRenderResult | undefined;
		if (typeof native !== "function") return new Container();
		return native(result, options, theme, { ...context, lastComponent: previous });
	};
	return render as NonNullable<NativeToolDefinition["renderResult"]>;
}

const PATCH_FLAG = "piCompactUiAdjacentRowSpacing";
const parents = new WeakMap<Component, Container>();
const blankDropped = new WeakSet<ToolExecutionComponent>();

function isSelfShellRow(row: ToolExecutionComponent): boolean {
	const definition = (row as unknown as { toolDefinition?: { renderShell?: string } }).toolDefinition;
	return definition?.renderShell === "self";
}

function isHiddenRow(component: Component): boolean {
	return (
		component instanceof ToolExecutionComponent &&
		(component as unknown as { hideComponent?: boolean }).hideComponent === true
	);
}

function previousSibling(row: ToolExecutionComponent): Component | undefined {
	const parent = parents.get(row);
	if (!parent) return undefined;
	for (let index = parent.children.indexOf(row) - 1; index >= 0; index -= 1) {
		const sibling = parent.children[index];
		if (!sibling || isHiddenRow(sibling)) continue;
		return sibling;
	}
	return undefined;
}

function collapseAdjacentToolRows(): void {
	const prototype = ToolExecutionComponent.prototype;
	if (Reflect.get(prototype, PATCH_FLAG) === true) return;
	const baseAddChild = Container.prototype.addChild;
	Container.prototype.addChild = function (this: Container, component: Component): void {
		parents.set(component, this);
		baseAddChild.call(this, component);
	};
	const baseRender = prototype.render;
	const baseHandleMouse = prototype.handleMouse;
	prototype.render = function (this: ToolExecutionComponent, width: number): string[] {
		const lines = baseRender.call(this, width);
		const drop = isSelfShellRow(this) && lines[0] === "" && previousSibling(this) instanceof ToolExecutionComponent;
		if (drop) blankDropped.add(this);
		else blankDropped.delete(this);
		return drop ? lines.slice(1) : lines;
	};
	prototype.handleMouse = function (
		this: ToolExecutionComponent,
		event: TuiMouseEvent,
	): ReturnType<ToolExecutionComponent["handleMouse"]> {
		return baseHandleMouse.call(this, blankDropped.has(this) ? { ...event, y: event.y + 1 } : event);
	};
	Reflect.set(prototype, PATCH_FLAG, true);
}

export default function (pi: ExtensionAPI) {
	collapseAdjacentToolRows();

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

	for (const name of ["read", "edit", "write", "find", "grep", "ls"] as const) {
		pi.registerTool({
			...getTools(process.cwd())[name],
			execute: delegate(name),
			renderCall: wrapRenderCall(name),
			renderResult: wrapRenderResult(name),
			renderShell: "self",
		});
	}
}
