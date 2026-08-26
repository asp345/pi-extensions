import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	isKeyRelease,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	buildAgentContextFullLines,
	CONTEXT_ROWS,
	renderAgentContext,
	renderAgentList,
	SCROLL_STEP,
} from "./context.ts";
import type { AgentManager } from "./manager.ts";
import type { AgentRecord } from "./types.ts";

interface WidgetTui {
	requestRender(force?: boolean): void;
}

export class AgentsUI {
	private context?: ExtensionContext;
	private widgetTui?: WidgetTui;
	private inputUnsub?: () => void;
	private selectedId?: string;
	private contextVisible = false;
	private topLine: number | null = null;
	private lastRenderWidth = 80;
	private opening = false;

	constructor(private readonly manager: AgentManager) {}

	attach(ctx: ExtensionContext): void {
		if (this.context !== ctx) {
			this.inputUnsub?.();
			this.context = ctx;
			this.inputUnsub = ctx.ui.onTerminalInput((data) => this.handleInput(data));
		}
		this.updateWidget();
	}

	detach(ctx: ExtensionContext): void {
		ctx.ui.setWidget("pi-subagents", undefined);
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		this.context = undefined;
		this.widgetTui = undefined;
		this.selectedId = undefined;
		this.contextVisible = false;
		this.topLine = null;
	}

	private selected(records: AgentRecord[]): AgentRecord | undefined {
		return records.find((record) => record.id === this.selectedId);
	}

	private handleInput(data: string): { consume?: boolean } | undefined {
		if (!this.context || this.opening || isKeyRelease(data)) return undefined;
		const focused = (this.widgetTui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (focused != null && !(focused instanceof Editor)) return undefined;
		if (this.contextVisible && matchesKey(data, "enter")) {
			const record = this.selected(this.manager.running());
			const prompt = this.context.ui.getEditorText().trim();
			if (record && prompt) {
				this.context.ui.setEditorText("");
				void this.manager
					.steer(record.id, prompt)
					.then((accepted) => {
						if (!accepted) this.context?.ui.notify("The steering message was rejected.", "warning");
					})
					.catch(() => this.context?.ui.notify("The steering message failed.", "warning"));
			}
			return { consume: true };
		}
		if (this.contextVisible && matchesKey(data, "escape") && this.context.ui.getEditorText() === "") {
			this.contextVisible = false;
			this.topLine = null;
			this.updateWidget(true);
			return { consume: true };
		}
		if (this.contextVisible && matchesKey(data, Key.pageUp)) {
			const record = this.selected(this.manager.running());
			if (record && this.context) {
				const theme = this.context.ui.theme;
				const fullLines = buildAgentContextFullLines(
					record,
					this.lastRenderWidth,
					theme,
					this.widgetTui as never,
					this.context.cwd,
				);
				const currentTop = this.topLine ?? Math.max(0, fullLines.length - CONTEXT_ROWS);
				this.topLine = Math.max(0, currentTop - SCROLL_STEP);
				this.updateWidget(true);
			}
			return { consume: true };
		}
		if (this.contextVisible && matchesKey(data, Key.pageDown)) {
			const record = this.selected(this.manager.running());
			if (record && this.context && this.topLine !== null) {
				const theme = this.context.ui.theme;
				const fullLines = buildAgentContextFullLines(
					record,
					this.lastRenderWidth,
					theme,
					this.widgetTui as never,
					this.context.cwd,
				);
				const nextTop = this.topLine + SCROLL_STEP;
				if (nextTop >= fullLines.length - CONTEXT_ROWS) {
					this.topLine = null;
				} else {
					this.topLine = nextTop;
				}
				this.updateWidget(true);
			}
			return { consume: true };
		}
		if (!matchesKey(data, "alt+a")) return undefined;
		if (!this.manager.running().length) return undefined;
		void this.open(this.context);
		return { consume: true };
	}

	updateWidget(force = false): void {
		const ctx = this.context;
		if (!ctx) return;
		const active = this.manager.running();
		if (!active.length) {
			const tui = this.widgetTui;
			if (tui) ctx.ui.setWidget("pi-subagents", undefined);
			this.widgetTui = undefined;
			this.selectedId = undefined;
			this.contextVisible = false;
			this.topLine = null;
			tui?.requestRender(true);
			return;
		}
		if (this.contextVisible && !this.selected(active)) {
			this.contextVisible = false;
			this.selectedId = undefined;
			this.topLine = null;
			force = true;
		}
		if (this.widgetTui) {
			this.widgetTui.requestRender(force);
			return;
		}
		ctx.ui.setWidget("pi-subagents", (tui, theme) => {
			this.widgetTui = tui;
			return {
				render: (width: number) => {
					this.lastRenderWidth = width;
					const records = this.manager.running();
					const separator = theme.fg("borderMuted", "─".repeat(width));
					const record = this.contextVisible ? this.selected(records) : undefined;
					return record
						? [
								separator,
								...renderAgentContext(
									record,
									width,
									theme,
									tui,
									ctx.cwd,
									CONTEXT_ROWS,
									this.topLine !== null ? { topLine: this.topLine } : null,
								),
							]
						: [
								separator,
								theme.fg("dim", ` Agents · ${records.length} running · Alt+A open`),
								...renderAgentList(records, width, theme),
							];
				},
				invalidate() {},
				dispose: () => {
					this.widgetTui = undefined;
				},
			};
		});
	}

	private chooseAgent(
		ctx: ExtensionContext,
		records: AgentRecord[],
	): Promise<{ action: "open" | "stop"; id: string } | undefined> {
		return ctx.ui.custom((tui, theme, _keys, done) => {
			const items: SelectItem[] = records.map((record) => ({
				value: record.id,
				label: `${record.type} · ${record.title}`,
				description: `${record.model ?? "model pending"} · ${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools`,
			}));
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done({ action: "open", id: item.value });
			list.onCancel = () => done(undefined);
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Agents")), 1, 0));
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter open · Alt+X stop · Esc close"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "alt+x")) {
						const selected = list.getSelectedItem();
						if (selected) done({ action: "stop", id: selected.value });
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async open(ctx: ExtensionContext, initial?: string): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Subagent context is available only in TUI mode.", "warning");
			return;
		}
		if (this.opening) return;
		this.opening = true;
		try {
			if (initial) {
				const record = this.manager
					.running()
					.find(
						(item) =>
							item.id === initial || item.id.startsWith(initial) || item.type.toLowerCase() === initial.toLowerCase(),
					);
				if (record) {
					this.selectedId = record.id;
					this.contextVisible = true;
					this.topLine = null;
					this.updateWidget(true);
				}
				return;
			}
			for (;;) {
				const records = this.manager.running();
				if (!records.length) {
					ctx.ui.notify("No active subagents.", "info");
					return;
				}
				const choice = await this.chooseAgent(ctx, records);
				if (!choice) return;
				if (choice.action === "stop") {
					if (this.manager.cancel(choice.id)) ctx.ui.notify(`Stopped ${choice.id.slice(0, 8)}.`, "info");
					this.updateWidget(true);
					continue;
				}
				this.selectedId = choice.id;
				this.contextVisible = true;
				this.topLine = null;
				this.updateWidget(true);
				return;
			}
		} finally {
			this.opening = false;
		}
	}
}
