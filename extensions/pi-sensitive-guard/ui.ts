import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, type GuardConfig, type Severity, loadConfig, saveConfig } from "./config.js";

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
				const choices = [
					`Guard: ${onOff(config.enabled)}`,
					`Read redaction: ${onOff(config.readRedaction.enabled)}`,
					`Read scope: ${config.readRedaction.scope}`,
					`Shell output redaction: ${onOff(config.readRedaction.includeShellOutput)}`,
					`Content scanning: ${onOff(config.contentScanning.enabled)}`,
					`Content severity: ${config.contentScanning.blockSeverity}`,
					`Git protection: ${onOff(config.gitProtection.enabled)}`,
					`Protected paths (${config.protectedPaths.length})`,
					`Allowed paths (${config.allowedPaths.length})`,
					"Show status",
					"Done",
				];
				const choice = await ctx.ui.select("Sensitive Guard", choices);
				if (!choice || choice === "Done") return;

				if (choice.startsWith("Guard:")) config.enabled = !config.enabled;
				else if (choice.startsWith("Read redaction:")) config.readRedaction.enabled = !config.readRedaction.enabled;
				else if (choice.startsWith("Read scope:"))
					config.readRedaction.scope = config.readRedaction.scope === "protectedOnly" ? "allOutput" : "protectedOnly";
				else if (choice.startsWith("Shell output"))
					config.readRedaction.includeShellOutput = !config.readRedaction.includeShellOutput;
				else if (choice.startsWith("Content scanning:"))
					config.contentScanning.enabled = !config.contentScanning.enabled;
				else if (choice.startsWith("Content severity:")) {
					const selected = await ctx.ui.select("Block findings at or above", ["critical", "high", "medium"]);
					if (selected) config.contentScanning.blockSeverity = selected as Severity;
				} else if (choice.startsWith("Git protection:")) config.gitProtection.enabled = !config.gitProtection.enabled;
				else if (choice.startsWith("Protected paths")) {
					const patterns = await editPatterns(ctx, "Protected path globs, one per line", config.protectedPaths);
					if (patterns) config.protectedPaths = patterns;
				} else if (choice.startsWith("Allowed paths")) {
					const patterns = await editPatterns(ctx, "Allowed path globs, one per line", config.allowedPaths);
					if (patterns) config.allowedPaths = patterns;
				} else if (choice === "Show status") {
					ctx.ui.notify(status(config), "info");
					continue;
				}

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
