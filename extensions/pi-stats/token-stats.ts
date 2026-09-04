import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StatsConfigStore } from "./config-store.ts";
import registerFooterCommand from "./footer-command.ts";
import { type MetricPartOptions, renderMetricParts } from "./metric-parts.ts";
import { QuotaController } from "./quota-controller.ts";
import type { SharedState } from "./types.ts";
import { UsageAccountant } from "./usage-accountant.ts";

interface TokenStatsHandle {
	/** Status-bar metrics excluding run timing, which index.ts appends. */
	getMetricParts(theme: Theme, ctx: ExtensionContext, options?: MetricPartOptions): string[];
}

export function createTokenStats(pi: ExtensionAPI, shared: SharedState): TokenStatsHandle {
	const accountant = new UsageAccountant();
	const store = new StatsConfigStore();
	const quota = new QuotaController({
		getConfig: () => store.current,
		isSessionActive: () => shared.sessionActive,
		requestRender: () => shared.requestRender?.(),
	});
	registerFooterCommand(pi, { store, quota, shared });

	pi.on("turn_start", (_event, ctx) => {
		accountant.beginTurn(Date.now());
		quota.handleProviderChange(ctx);
		shared.requestRender?.();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const content = event.message.content;
		if (!Array.isArray(content)) return;

		const streamEvent = (
			event as typeof event & {
				assistantMessageEvent?: {
					type?: string;
					delta: string;
					partial?: { usage?: { output?: number } };
				};
			}
		).assistantMessageEvent;
		if (
			streamEvent?.type !== "text_delta" &&
			streamEvent?.type !== "thinking_delta" &&
			streamEvent?.type !== "toolcall_delta"
		) {
			accountant.markStreaming();
			return;
		}

		if (accountant.recordStreamDelta(streamEvent.delta.length, streamEvent.partial?.usage?.output, Date.now())) {
			shared.requestRender?.();
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (accountant.recordAssistantEnd(event.message as AssistantMessage, Date.now())) {
			shared.requestRender?.();
		}
	});

	pi.on("agent_end", () => {
		accountant.endStreaming();
		shared.requestRender?.();
	});

	pi.on("session_shutdown", () => {
		// Clear timers and captured contexts before Pi invalidates the session context.
		shared.sessionActive = false;
		quota.stop();
		shared.requestRender = null;
	});

	pi.on("session_start", async (_event, ctx) => {
		shared.sessionActive = true;
		accountant.rebuildFromHistory(ctx.sessionManager.getBranch());
		await store.load();
		quota.start(ctx);
	});

	return {
		getMetricParts: (theme, ctx, options) =>
			renderMetricParts({ theme, ctx, accountant, displayConfig: store.display, quota, options }),
	};
}
