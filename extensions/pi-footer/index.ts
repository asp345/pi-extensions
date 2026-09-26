import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FooterConfigStore } from "./config.ts";
import registerFooterCommand from "./footer-command.ts";
import { formatUserPath } from "./format.ts";
import { type MetricPartOptions, renderMetricParts } from "./metric-parts.ts";
import { QuotaController } from "./quota-controller.ts";
import { UsageAccountant } from "./usage-accountant.ts";

export default function piFooterExtension(pi: ExtensionAPI): void {
	let sessionActive = false;
	let renderFooter: (() => void) | null = null;
	const requestRender = () => renderFooter?.();
	const accountant = new UsageAccountant();
	const store = new FooterConfigStore();
	const quota = new QuotaController({
		getTtl: () => store.config.ttl,
		isSessionActive: () => sessionActive,
		requestRender,
	});
	registerFooterCommand(pi, store, quota, requestRender);

	pi.on("turn_start", (_event, ctx) => {
		accountant.beginTurn(Date.now());
		quota.handleProviderChange(ctx);
		requestRender();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) {
			accountant.markStreaming();
			return;
		}
		if (
			accountant.recordStreamDelta(
				streamEvent.delta,
				streamEvent.partial.responseId,
				streamEvent.partial.usage?.output,
				Date.now(),
			)
		) {
			requestRender();
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		accountant.recordAssistantEnd(event.message, Date.now());
		requestRender();
	});

	pi.on("agent_end", () => {
		accountant.endStreaming();
		requestRender();
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		quota.stop();
		renderFooter = null;
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = true;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const render = () => tui.requestRender();
			renderFooter = render;
			const unsubscribe = footerData.onBranchChange(render);
			const metricParts = (options?: MetricPartOptions) =>
				renderMetricParts({ theme, ctx, accountant, displayConfig: store.config.display, quota, options });

			return {
				dispose() {
					unsubscribe();
					if (renderFooter === render) renderFooter = null;
				},
				invalidate() {},
				render(width: number): string[] {
					if (!sessionActive) return [];
					const separator = theme.fg("dim", " | ");
					let left = metricParts().join(separator);
					const modelName = ctx.model?.id ?? "";
					const provider = ctx.model?.provider ?? "";
					const thinkingLevel = ctx.thinkingLevel ?? "off";
					const model = theme.fg("dim", `${provider ? `(${provider}) ` : ""}${modelName} · ${thinkingLevel}`);
					const modelWidth = visibleWidth(model);
					const fitsWithModel = (value: string) => visibleWidth(value) + modelWidth + 2 <= width;
					if (!fitsWithModel(left)) {
						left = metricParts({ speed: false }).join(separator);
					}
					if (!fitsWithModel(left)) {
						left = metricParts({ speed: false, quota: false }).join(separator);
					}
					const leftWidth = visibleWidth(left);
					const topLine = fitsWithModel(left)
						? left + " ".repeat(width - leftWidth - modelWidth) + model
						: modelWidth <= width
							? " ".repeat(width - modelWidth) + model
							: truncateToWidth(model, width, "");

					const cwd = formatUserPath(ctx.cwd ?? "");
					const branch = footerData.getGitBranch();
					const bottomParts = [theme.fg("dim", branch ? `${cwd} (${branch})` : cwd)];
					const statuses = Array.from(footerData.getExtensionStatuses().values());
					if (statuses.length > 0) bottomParts.push(theme.fg("dim", "│"), ...statuses);

					return [truncateToWidth(topLine, width), truncateToWidth(bottomParts.join(" "), width)];
				},
			};
		});

		accountant.restoreLastSpeed(ctx.sessionManager.getBranch());
		await store.load();
		quota.start(ctx);
	});
}
