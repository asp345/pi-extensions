import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatUserPath } from "./format.ts";
import { createStepTimer } from "./step-timer.ts";
import { createTokenStats, type SharedState } from "./token-stats.ts";

const shared: SharedState = {
	sessionActive: false,
	requestRender: null,
};

export default function piStatsExtension(pi: ExtensionAPI): void {
	const stats = createTokenStats(pi, shared);
	createStepTimer(pi);

	pi.on("session_start", (_event, ctx) => {
		shared.sessionActive = true;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const render = () => tui.requestRender();
			shared.requestRender = render;
			const unsubscribe = footerData.onBranchChange(render);

			return {
				dispose() {
					unsubscribe();
					if (shared.requestRender === render) shared.requestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					if (!shared.sessionActive) return [];
					const left = stats.getMetricParts(theme, ctx).join(theme.fg("dim", " | "));
					const modelName = ctx.model?.id ?? "";
					const provider = ctx.model?.provider ?? "";
					const thinkingLevel = ctx.thinkingLevel ?? "off";
					const model = theme.fg("dim", `${provider ? `(${provider}) ` : ""}${modelName} · ${thinkingLevel}`);
					const leftWidth = visibleWidth(left);
					const modelWidth = visibleWidth(model);
					const topLine =
						leftWidth + modelWidth <= width
							? left + " ".repeat(width - leftWidth - modelWidth) + model
							: leftWidth <= width
								? left + " ".repeat(width - leftWidth) + truncateToWidth(model, Math.max(0, width - leftWidth), "")
								: truncateToWidth(left, width);

					const cwd = formatUserPath(ctx.cwd ?? "");
					const branch = footerData.getGitBranch();
					const bottomParts = [theme.fg("dim", branch ? `${cwd} (${branch})` : cwd)];
					const statuses = Array.from(footerData.getExtensionStatuses().values());
					if (statuses.length > 0) bottomParts.push(theme.fg("dim", "│"), ...statuses);

					return [truncateToWidth(topLine, width), truncateToWidth(bottomParts.join(" "), width)];
				},
			};
		});
	});

	pi.on("session_shutdown", () => {
		shared.sessionActive = false;
		shared.requestRender = null;
	});
}
