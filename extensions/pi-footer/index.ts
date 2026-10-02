import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FooterConfigStore } from "./config.ts";
import registerFooterCommand from "./footer-command.ts";
import { formatUserPath, singleLine } from "./format.ts";
import { cachedSessionStats, type MetricPartOptions, renderMetricParts } from "./metric-parts.ts";
import { QuotaController } from "./quota-controller.ts";
import { UsageAccountant } from "./usage-accountant.ts";

export default function piFooterExtension(pi: ExtensionAPI): void {
	let sessionActive = false;
	let renderFooter: (() => void) | null = null;
	const requestRender = () => renderFooter?.();
	const accountant = new UsageAccountant();
	const sessionStats = cachedSessionStats();
	const store = new FooterConfigStore();
	const quota = new QuotaController(() => store.config.ttl, requestRender);
	registerFooterCommand(pi, store, quota, requestRender);

	pi.on("model_select", (event) => {
		quota.setProvider(event.model.provider);
		requestRender();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") accountant.beginMessage();
	});

	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") {
			accountant.recordStreamDelta(Date.now());
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		accountant.recordAssistantEnd(event.message);
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
				renderMetricParts({
					theme,
					ctx,
					stats: sessionStats(ctx),
					accountant,
					displayConfig: store.config.display,
					quota,
					options,
				});
			const modelLabel = (withProvider: boolean) => {
				const model = ctx.model;
				const provider = withProvider && model ? `(${model.provider}) ` : "";
				const thinking = model?.reasoning ? ` · ${ctx.thinkingLevel ?? "off"}` : "";
				return theme.fg("dim", `${provider}${model?.id ?? ""}${thinking}`);
			};

			return {
				dispose() {
					unsubscribe();
					if (renderFooter === render) renderFooter = null;
				},
				invalidate() {},
				render(width: number): string[] {
					if (!sessionActive) return [];
					const separator = theme.fg("dim", " | ");
					const full = metricParts().join(separator);
					const model = modelLabel(false);
					const candidates: (() => [string, string])[] = [
						...(footerData.getAvailableProviderCount() > 1 ? [(): [string, string] => [full, modelLabel(true)]] : []),
						() => [full, model],
						() => [metricParts({ speed: false }).join(separator), model],
						() => [metricParts({ speed: false, quota: false }).join(separator), model],
					];
					let fit: [string, string] | undefined;
					for (const candidate of candidates) {
						const [left, right] = candidate();
						if (visibleWidth(left) + visibleWidth(right) + 2 > width) continue;
						fit = [left, right];
						break;
					}
					const modelWidth = visibleWidth(model);
					const topLine = fit
						? fit[0] + " ".repeat(width - visibleWidth(fit[0]) - visibleWidth(fit[1])) + fit[1]
						: modelWidth <= width
							? " ".repeat(width - modelWidth) + model
							: truncateToWidth(model, width, "");

					const cwd = formatUserPath(ctx.cwd ?? "");
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					const location = `${branch ? `${cwd} (${branch})` : cwd}${sessionName ? ` · ${sessionName}` : ""}`;
					const bottomParts = [theme.fg("dim", location)];
					const statuses = [...footerData.getExtensionStatuses()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => singleLine(text));
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
