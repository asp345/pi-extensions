import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderToolRow, rowStatus, type ToolRowState, WORKING_ICON_INTERVAL_MS } from "./row.ts";

const PARENT = Symbol.for("pi-compact-ui:parent");
const TIMING = Symbol.for("pi-compact-ui:timing");
const HEADER_ROW = Symbol.for("pi-compact-ui:header-row");
const BASE_PATCHED = Symbol.for("pi-compact-ui:base-patched");

interface RowFields {
	toolName: string;
	args: unknown;
	cwd: string;
	expanded: boolean;
	executionStarted: boolean;
	isPartial: boolean;
	result?: ToolRowState["result"];
	imageComponents: Component[];
	imageSpacers: Component[];
	ui: { requestRender(): void };
}

interface Timing {
	startedAt?: number;
	endedAt?: number;
}

function fields(row: ToolExecutionComponent): RowFields {
	return row as unknown as RowFields;
}

function timing(row: ToolExecutionComponent): Timing {
	const existing = Reflect.get(row, TIMING) as Timing | undefined;
	if (existing) return existing;
	const created: Timing = {};
	Reflect.set(row, TIMING, created);
	return created;
}

function parentOf(component: Component): Container | undefined {
	return Reflect.get(component, PARENT) as Container | undefined;
}

function rowState(row: ToolExecutionComponent): ToolRowState {
	const view = fields(row);
	return {
		name: view.toolName,
		args: view.args,
		cwd: view.cwd,
		expanded: view.expanded,
		executionStarted: view.executionStarted,
		isPartial: view.isPartial,
		result: view.result,
		...timing(row),
	};
}

function followsToolRow(row: ToolExecutionComponent, width: number): boolean {
	const parent = parentOf(row);
	if (!parent) return false;
	for (let index = parent.children.indexOf(row) - 1; index >= 0; index -= 1) {
		const sibling = parent.children[index];
		if (sibling instanceof ToolExecutionComponent) return true;
		if (sibling instanceof AssistantMessageComponent && sibling.render(width).length === 0) continue;
		return false;
	}
	return false;
}

function installBasePatches(): void {
	const prototype = ToolExecutionComponent.prototype;
	if (Reflect.get(prototype, BASE_PATCHED) === true) return;
	const baseAddChild = Container.prototype.addChild;
	Container.prototype.addChild = function (this: Container, component: Component): void {
		Reflect.set(component, PARENT, this);
		baseAddChild.call(this, component);
	};
	const baseMarkExecutionStarted = prototype.markExecutionStarted;
	prototype.markExecutionStarted = function (this: ToolExecutionComponent): void {
		timing(this).startedAt ??= Date.now();
		baseMarkExecutionStarted.call(this);
	};
	const baseUpdateResult = prototype.updateResult;
	prototype.updateResult = function (
		this: ToolExecutionComponent,
		...args: Parameters<ToolExecutionComponent["updateResult"]>
	): void {
		const [, isPartial = false] = args;
		const current = timing(this);
		if (!isPartial && current.startedAt !== undefined) current.endedAt ??= Date.now();
		baseUpdateResult.apply(this, args);
	};
	Reflect.set(prototype, BASE_PATCHED, true);
}

function installRenderer(ui: { readonly theme: Theme }): void {
	const running = new Set<ToolExecutionComponent>();
	let ticker: ReturnType<typeof setInterval> | undefined;

	const tick = (): void => {
		let target: RowFields["ui"] | undefined;
		for (const row of running) {
			const attached = parentOf(row)?.children.includes(row) === true;
			if (!attached || rowStatus(rowState(row)) !== "running") running.delete(row);
			else target = fields(row).ui;
		}
		if (running.size === 0) {
			clearInterval(ticker);
			ticker = undefined;
			return;
		}
		target?.requestRender();
	};

	const prototype = ToolExecutionComponent.prototype;
	prototype.render = function (this: ToolExecutionComponent, width: number): string[] {
		const state = rowState(this);
		if (rowStatus(state) === "running") {
			running.add(this);
			if (!ticker) {
				ticker = setInterval(tick, WORKING_ICON_INTERVAL_MS);
				ticker.unref?.();
			}
		}
		const view = fields(this);
		const lines = renderToolRow(state, ui.theme, width, Date.now());
		view.imageComponents.forEach((image, index) => {
			lines.push(...(view.imageSpacers[index]?.render(width) ?? []), ...image.render(width));
		});
		const leadingBlank = !followsToolRow(this, width);
		Reflect.set(this, HEADER_ROW, leadingBlank ? 1 : 0);
		return leadingBlank ? ["", ...lines] : lines;
	};
	prototype.handleMouse = function (
		this: ToolExecutionComponent,
		event: TuiMouseEvent,
	): ReturnType<ToolExecutionComponent["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y !== (Reflect.get(this, HEADER_ROW) ?? 1)) return undefined;
		this.setExpanded(!fields(this).expanded);
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	};
}

export default function compactUi(pi: ExtensionAPI): void {
	installBasePatches();
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") installRenderer(ctx.ui);
	});
}
