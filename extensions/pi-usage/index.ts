import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCredential } from "./auth.ts";
import { formatReport } from "./format.ts";
import { anthropicUsageProvider } from "./providers/anthropic.ts";
import { antigravityUsageProvider } from "./providers/antigravity.ts";
import { openaiCodexUsageProvider } from "./providers/openai-codex.ts";
import { xaiUsageProvider } from "./providers/xai.ts";
import type { UsageProvider, UsageReport } from "./types.ts";

const PROVIDERS: UsageProvider[] = [
	anthropicUsageProvider,
	openaiCodexUsageProvider,
	antigravityUsageProvider,
	xaiUsageProvider,
];

const COMMAND = "usage";

function notifyMany(
	ctx: { ui: { notify: (message: string, level: "info" | "warning" | "error") => void } },
	lines: string[],
): void {
	const message = lines.join("\n");
	ctx.ui.notify(message, "info");
}

export default async function usage(pi: ExtensionAPI): Promise<void> {
	pi.registerCommand(COMMAND, {
		description: "Show current provider usage limits (Anthropic, OpenAI Codex, Antigravity, xAI)",
		handler: async (args, ctx) => {
			const requested = args.trim();
			const theme = ctx.ui.theme;
			const fg = (color: string, text: string) => theme.fg(color as never, text);
			const targets = requested
				? PROVIDERS.filter((provider) => provider.id === requested || provider.id.includes(requested))
				: PROVIDERS;

			if (targets.length === 0) {
				ctx.ui.notify(
					`Unknown provider "${requested}". Available: ${PROVIDERS.map((p) => p.id).join(", ")}`,
					"warning",
				);
				return;
			}

			const results = await Promise.allSettled(
				targets.map(async (provider) => {
					try {
						const credential = await resolveCredential(provider.id, ctx);
						if (!credential) return null;
						const report = await provider.fetchUsage(credential, ctx.signal);
						return { provider: provider.id, report, error: report ? null : "no usage data returned" };
					} catch (error) {
						return {
							provider: provider.id,
							report: null,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);

			const lines: string[] = [];
			for (const result of results) {
				if (result.status !== "fulfilled" || !result.value) continue;
				const { provider, report, error } = result.value;
				if (report) {
					lines.push(...formatReport(report, fg));
				} else {
					lines.push(`${fg("accent", provider)}`);
					lines.push(`  ${fg("dim", error ?? "no usage data")}`);
				}
				lines.push("");
			}

			const filtered = lines.filter((line, index) => !(line === "" && lines[index - 1] === ""));
			if (filtered.length === 0) {
				ctx.ui.notify("No configured providers with credentials. Use /login to add one.", "info");
				return;
			}
			notifyMany(ctx, filtered);
		},
	});
}

export type { UsageReport };
