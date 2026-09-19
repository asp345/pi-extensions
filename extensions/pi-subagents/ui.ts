import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "./manager.ts";

const WIDGET = "pi-subagents";

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

interface WidgetTui {
	requestRender(force?: boolean): void;
}

export class AgentsUI {
	private context?: ExtensionContext;
	private widgetTui?: WidgetTui;
	private mounted = false;

	constructor(private readonly manager: AgentManager) {}

	attach(ctx: ExtensionContext): void {
		this.context = ctx;
		this.updateWidget();
	}

	detach(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET, undefined);
		this.context = undefined;
		this.widgetTui = undefined;
		this.mounted = false;
	}

	updateWidget(force = false): void {
		const ctx = this.context;
		if (!ctx) return;
		if (!this.manager.running().length) {
			if (this.mounted) ctx.ui.setWidget(WIDGET, undefined);
			this.mounted = false;
			this.widgetTui = undefined;
			return;
		}
		if (this.mounted) {
			this.widgetTui?.requestRender(force);
			return;
		}
		this.mounted = true;
		ctx.ui.setWidget(
			WIDGET,
			(tui, theme) => {
				this.widgetTui = tui;
				return {
					render: (width: number) => {
						const running = this.manager.running();
						const latest = running[running.length - 1];
						const lines = [
							`${theme.fg("accent", theme.bold("Subagents"))} ${theme.fg("muted", `${running.length} running`)}`,
						];
						if (latest) {
							lines.push(
								theme.fg(
									"dim",
									`${latest.type} · ${oneLine(latest.title)} · ${latest.id.slice(0, 8)} · ${latest.turns} turns`,
								),
							);
						}
						return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
					},
					invalidate() {},
					dispose: () => {
						this.widgetTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}
}
