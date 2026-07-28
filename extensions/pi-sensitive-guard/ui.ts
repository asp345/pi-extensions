import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, type GuardConfig, loadConfig, type Severity, saveConfig } from "./config.js";

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

function status(config: GuardConfig): string {
	return [
		"Sensitive Guard",
		`Guard: ${onOff(config.enabled)}`,
		`Read redaction: ${onOff(config.readRedaction.enabled)} (${config.readRedaction.scope})`,
		`Shell output redaction: ${onOff(config.readRedaction.includeShellOutput)}`,
		`Content scanning: ${onOff(config.contentScanning.enabled)} (${config.contentScanning.blockSeverity})`,
		`Git protection: ${onOff(config.gitProtection.enabled)}`,
		`Custom protected paths: ${config.protectedPaths.length}`,
		`Allowed paths: ${config.allowedPaths.length}`,
	].join("\n");
}

async function editPatterns(
	ctx: ExtensionCommandContext,
	title: string,
	current: string[],
): Promise<string[] | undefined> {
	const edited = await ctx.ui.editor(title, `${current.join("\n")}\n`);
	if (edited === undefined) return undefined;
	return [
		...new Set(
			edited
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
}

export function registerSensitiveGuardUI(pi: ExtensionAPI, apply: (config: GuardConfig) => void): void {
	pi.registerCommand("sensitive-guard", {
		description: "Configure sensitive path, scanning, and redaction protection",
		handler: async (args, ctx) => {
			let config = loadConfig();
			if (args.trim().toLowerCase() === "status") {
				ctx.ui.notify(status(config), "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`UI unavailable. Edit ${CONFIG_PATH}.`, "warning");
				return;
			}

			for (;;) {
				const entries: Array<{ label: string; run: () => void | Promise<void> }> = [
					{
						label: `Guard: ${onOff(config.enabled)}`,
						run: () => {
							config.enabled = !config.enabled;
						},
					},
					{
						label: `Read redaction: ${onOff(config.readRedaction.enabled)}`,
						run: () => {
							config.readRedaction.enabled = !config.readRedaction.enabled;
						},
					},
					{
						label: `Read scope: ${config.readRedaction.scope}`,
						run: () => {
							config.readRedaction.scope =
								config.readRedaction.scope === "protectedOnly" ? "allOutput" : "protectedOnly";
						},
					},
					{
						label: `Shell output redaction: ${onOff(config.readRedaction.includeShellOutput)}`,
						run: () => {
							config.readRedaction.includeShellOutput = !config.readRedaction.includeShellOutput;
						},
					},
					{
						label: `Content scanning: ${onOff(config.contentScanning.enabled)}`,
						run: () => {
							config.contentScanning.enabled = !config.contentScanning.enabled;
						},
					},
					{
						label: `Content severity: ${config.contentScanning.blockSeverity}`,
						run: async () => {
							const selected = await ctx.ui.select("Block findings at or above", ["critical", "high", "medium"]);
							if (selected) config.contentScanning.blockSeverity = selected as Severity;
						},
					},
					{
						label: `Git protection: ${onOff(config.gitProtection.enabled)}`,
						run: () => {
							config.gitProtection.enabled = !config.gitProtection.enabled;
						},
					},
					{
						label: `Protected paths (${config.protectedPaths.length})`,
						run: async () => {
							const patterns = await editPatterns(ctx, "Protected path globs, one per line", config.protectedPaths);
							if (patterns) config.protectedPaths = patterns;
						},
					},
					{
						label: `Allowed paths (${config.allowedPaths.length})`,
						run: async () => {
							const patterns = await editPatterns(ctx, "Allowed path globs, one per line", config.allowedPaths);
							if (patterns) config.allowedPaths = patterns;
						},
					},
				];
				const choice = await ctx.ui.select("Sensitive Guard", [
					...entries.map((entry) => entry.label),
					"Show status",
					"Done",
				]);
				if (!choice || choice === "Done") return;
				if (choice === "Show status") {
					ctx.ui.notify(status(config), "info");
					continue;
				}
				await entries.find((entry) => entry.label === choice)?.run();

				try {
					saveConfig(config);
					config = loadConfig();
					apply(config);
				} catch (error) {
					ctx.ui.notify(
						`Sensitive Guard could not save configuration: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		},
	});
}
