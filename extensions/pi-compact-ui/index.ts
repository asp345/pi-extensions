/**
 * compact-ui: one line per built-in tool call, no grouping.
 *
 * Built-in tools (read, bash, edit, write, find, grep, ls) are re-registered
 * with a one-line call renderer and execution delegated to the native per-cwd
 * definitions. Collapsed results render nothing except for edit (native diff)
 * and write (native content preview); expanded (Ctrl+O) results delegate to the
 * native renderer. Thinking and everything else render natively; this extension
 * owns no transcript state.
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
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Container, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PENDING_ICON = "◌";
const ELLIPSIS = "…";
/** Kept empty at the right edge so a truncated line does not touch the viewport border. */
const RIGHT_MARGIN = 1;
const ALWAYS_RENDERED_RESULTS: ReadonlySet<ToolName> = new Set(["edit", "write"]);
const WRITE_INDENT = 3;

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

export interface CompactSummary {
	name: string;
	content: string;
	/** Kept visible when the content is truncated to the viewport width. */
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

/**
 * Indents a native renderer and drops its leading header: `skip` lines plus the blank lines that
 * follow (the edit result renderer prepends a Spacer(1), the write call renderer a `write <path>`
 * line).
 */
class TrimmedResult implements Component {
	private dropped = 0;

	constructor(
		readonly inner: Component,
		readonly skip: number,
		readonly indent: number,
	) {}

	render(width: number): string[] {
		const lines = this.inner.render(Math.max(1, width - this.indent));
		if (lines.length === 0) return lines;
		let start = Math.min(this.skip, lines.length);
		while (start < lines.length && stripTerminalSequences(lines[start] ?? "").trim() === "") start += 1;
		this.dropped = start;
		const indent = " ".repeat(this.indent);
		return lines.slice(start).map((line) => (line === "" ? line : `${indent}${line}`));
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	handleMouse(event: TuiMouseEvent) {
		return this.inner.handleMouse?.({ ...event, y: event.y + this.dropped });
	}
}

interface RenderResultContext {
	cwd: string;
	args: unknown;
	isError: boolean;
	lastComponent?: Component;
}

type NativeRenderCall = (args: unknown, theme: Theme, context: RenderResultContext) => Component;
type NativeRenderResult = (
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderResultContext,
) => Component;

function trimmedResult(previous: Component | undefined, component: Component, skip: number, indent: number): Component {
	if (
		previous instanceof TrimmedResult &&
		previous.inner === component &&
		previous.skip === skip &&
		previous.indent === indent
	)
		return previous;
	return new TrimmedResult(component, skip, indent);
}

function wrapRenderResult(name: ToolName): NonNullable<NativeToolDefinition["renderResult"]> {
	const render = (
		result: unknown,
		options: { expanded: boolean },
		theme: Theme,
		context: RenderResultContext,
	): Component => {
		if (!options.expanded && !ALWAYS_RENDERED_RESULTS.has(name)) return new Container();
		const tool = getTools(context.cwd)[name];
		const previous = context.lastComponent;
		const lastComponent = previous instanceof TrimmedResult ? previous.inner : previous;
		const nativeContext = { ...context, lastComponent };
		if (name === "write" && !context.isError) {
			const nativeCall = tool.renderCall as NativeRenderCall | undefined;
			if (typeof nativeCall !== "function") return new Container();
			return trimmedResult(previous, nativeCall(context.args, theme, nativeContext), 1, WRITE_INDENT);
		}
		const native = tool.renderResult as NativeRenderResult | undefined;
		if (typeof native !== "function") return new Container();
		return trimmedResult(previous, native(result, options, theme, nativeContext), 0, 0);
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

/**
 * ToolExecutionComponent.render() prepends one blank line to every self-shell row and
 * handleMouse() maps viewport rows through that offset. Drop it when the row directly
 * follows another tool row, so consecutive tool calls form one block.
 */
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
