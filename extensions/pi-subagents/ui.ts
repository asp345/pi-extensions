import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease } from "@earendil-works/pi-tui";
import { definitionTemplate, parseDefinition, safeDefinitionName } from "./definitions.js";
import type { AgentManager } from "./manager.js";
import {
	agentOptions,
	cycleOption,
	handleSelectorKey,
	renderSelectorLines,
	selectorKey,
	type SelectorState,
} from "./selector.js";
import type { AgentDefinition, AgentRecord, DefinitionRegistry } from "./types.js";
import { showAgentWorkspace } from "./workspace.js";

export class AgentsUI {
	private context?: ExtensionContext;
	private renderWorkspace?: () => void;
	private renderWidget?: () => void;
	private widgetTui?: unknown;
	private inputUnsub?: () => void;
	private widgetMounted = false;
	private readonly selector: SelectorState = { active: false, index: 0 };
	private opening = false;

	constructor(
		private readonly manager: AgentManager,
		private readonly registry: () => DefinitionRegistry,
		private readonly reload: (ctx: ExtensionContext) => void,
	) {}

	attach(ctx: ExtensionContext): void {
		if (this.context !== ctx) {
			this.inputUnsub?.();
			this.context = ctx;
			this.inputUnsub = ctx.ui.onTerminalInput((data) => this.handleFleetInput(data));
		}
		this.updateWidget();
	}

	detach(ctx: ExtensionContext): void {
		ctx.ui.setWidget("pi-subagents", undefined);
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		this.context = undefined;
		this.renderWorkspace = undefined;
		this.renderWidget = undefined;
		this.widgetTui = undefined;
		this.widgetMounted = false;
		this.selector.active = false;
		this.selector.index = 0;
	}

	private activeRecords(): AgentRecord[] {
		return this.manager
			.list()
			.filter((record) => record.status === "running")
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	private handleFleetInput(data: string): { consume?: boolean } | undefined {
		const ctx = this.context;
		if (!ctx || this.opening || isKeyRelease(data)) return undefined;
		const focused = (this.widgetTui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (focused != null && !(focused instanceof Editor)) {
			this.selector.active = false;
			return undefined;
		}
		const key = selectorKey(data);
		const options = agentOptions(this.activeRecords());
		if (key === "shift+down" || key === "shift+up") {
			const option = cycleOption(options, undefined, key === "shift+down" ? "next" : "previous");
			this.selector.active = false;
			if (option) void this.open(ctx, option.id);
			this.updateWidget();
			return option ? { consume: true } : undefined;
		}
		const wasActive = this.selector.active;
		const outcome = handleSelectorKey(this.selector, key, options, ctx.ui.getEditorText() === "");
		if (outcome.commit) void this.open(ctx, outcome.commit.id);
		if (outcome.consume || wasActive !== this.selector.active) this.updateWidget();
		return outcome.consume ? { consume: true } : undefined;
	}

	updateWidget(): void {
		try {
			this.renderWorkspace?.();
		} catch {
			this.renderWorkspace = undefined;
		}
		const ctx = this.context;
		if (!ctx) return;
		if (this.opening) {
			if (this.widgetMounted) ctx.ui.setWidget("pi-subagents", undefined);
			this.widgetMounted = false;
			this.renderWidget = undefined;
			this.widgetTui = undefined;
			this.selector.active = false;
			this.selector.index = 0;
			return;
		}
		const active = this.activeRecords();
		if (!active.length) {
			if (this.widgetMounted) ctx.ui.setWidget("pi-subagents", undefined);
			this.widgetMounted = false;
			this.renderWidget = undefined;
			this.widgetTui = undefined;
			this.selector.active = false;
			this.selector.index = 0;
			return;
		}
		this.selector.index = Math.min(this.selector.index, active.length - 1);
		if (this.widgetMounted) {
			this.renderWidget?.();
			return;
		}
		this.widgetMounted = true;
		ctx.ui.setWidget(
			"pi-subagents",
			(tui, theme) => {
				this.widgetTui = tui;
				this.renderWidget = () => tui.requestRender();
				return {
					render: (width: number) => {
						const current = this.activeRecords();
						const hint = this.selector.active ? "↑↓ choose · enter open · esc back" : "↓ choose · shift+↑↓ open";
						return renderSelectorLines(
							theme,
							width,
							`Agents (${current.length} active)`,
							hint,
							agentOptions(current),
							this.selector,
						);
					},
					invalidate() {},
					dispose: () => {
						this.widgetMounted = false;
						this.renderWidget = undefined;
						this.widgetTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	async open(ctx: ExtensionContext, initial?: string): Promise<void> {
		if (this.opening) {
			ctx.ui.notify("The agent workspace is already open.", "info");
			return;
		}
		this.opening = true;
		this.attach(ctx);
		let selectedId = initial?.trim() || undefined;
		try {
			for (;;) {
				const result = await showAgentWorkspace(ctx, this.manager, this.registry, selectedId, (refresh) => {
					this.renderWorkspace = refresh;
				});
				selectedId = result.selectedId;
				if (result.action === "close") return;
				if (result.action === "definitions") await this.definitions(ctx);
				else await this.create(ctx);
			}
		} finally {
			this.opening = false;
			this.updateWidget();
		}
	}

	private async definitions(ctx: ExtensionContext): Promise<void> {
		const registry = this.registry();
		const definitions = [...registry.definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
		const items = [
			...definitions.map(
				(definition) => `${definition.enabled ? "on " : "off"} · ${definition.name} · ${definition.source}`,
			),
			...(registry.errors.length ? ["Configuration errors"] : []),
		];
		const selected = await ctx.ui.select("Agent definitions", items);
		if (!selected) return;
		if (selected === "Configuration errors") {
			ctx.ui.notify(registry.errors.join("\n"), "warning");
			return;
		}
		const index = items.indexOf(selected);
		const definition = definitions[index];
		if (definition) await this.definitionActions(ctx, definition);
	}

	private async definitionActions(ctx: ExtensionContext, definition: AgentDefinition): Promise<void> {
		const actions = ["View", "Edit"];
		if (definition.source !== "default") actions.push("Delete");
		const action = await ctx.ui.select(definition.name, actions);
		if (action === "View") {
			await ctx.ui.editor(`${definition.name} (${definition.path})`, readFileSync(definition.path, "utf8"));
		} else if (action === "Edit") {
			let target = definition.path;
			if (definition.source === "default") {
				const scope = await ctx.ui.select("Save override", ["Project", "Global"]);
				if (!scope) return;
				target =
					scope === "Project"
						? join(ctx.cwd, CONFIG_DIR_NAME, "agents", `${definition.name}.md`)
						: join(getAgentDir(), "agents", `${definition.name}.md`);
			}
			await this.editFile(
				ctx,
				target,
				readFileSync(definition.path, "utf8"),
				definition.source === "default" ? (target.includes(ctx.cwd) ? "project" : "global") : definition.source,
			);
		} else if (action === "Delete") {
			if (await ctx.ui.confirm("Delete definition?", definition.path)) {
				unlinkSync(definition.path);
				this.reload(ctx);
			}
		}
	}

	private async create(ctx: ExtensionContext): Promise<void> {
		const name = (await ctx.ui.input("Agent name", "MyAgent"))?.trim();
		if (!name) return;
		if (!safeDefinitionName(name)) {
			ctx.ui.notify("Use 1-64 letters, digits, dots, underscores, or hyphens.", "warning");
			return;
		}
		const scope = await ctx.ui.select("Definition scope", ["Project", "Global"]);
		if (!scope) return;
		const path =
			scope === "Project"
				? join(ctx.cwd, CONFIG_DIR_NAME, "agents", `${name}.md`)
				: join(getAgentDir(), "agents", `${name}.md`);
		await this.editFile(ctx, path, definitionTemplate(name), scope === "Project" ? "project" : "global");
	}

	private async editFile(
		ctx: ExtensionContext,
		path: string,
		initial: string,
		source: AgentDefinition["source"],
	): Promise<void> {
		const content = await ctx.ui.editor(`Edit ${path}`, initial);
		if (content === undefined) return;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, { mode: 0o600 });
		try {
			parseDefinition(path, source);
			this.reload(ctx);
			ctx.ui.notify(`Saved ${path}`, "info");
		} catch (error) {
			this.reload(ctx);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	}
}
