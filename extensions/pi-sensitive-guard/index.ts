import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProtectedPath, loadConfig } from "./config.ts";
import { inspectGit } from "./git.ts";
import { redactOutput, scanSecrets } from "./scanner.ts";
import { expandShellWord, inspectShell } from "./shell.ts";

import { registerSensitiveGuardUI } from "./ui.ts";

function replacementText(input: Record<string, unknown>): string {
	const chunks: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") chunks.push(value);
		else if (Array.isArray(value)) value.forEach(collect);
		else if (value && typeof value === "object") {
			const entry = value as Record<string, unknown>;
			for (const key of [
				"newText",
				"new_text",
				"text",
				"content",
				"lines",
				"edits",
				"set_line",
				"replace_lines",
				"insert_after",
				"replace",
			])
				collect(entry[key]);
		}
	};
	for (const key of ["newText", "new_text", "edits"]) collect(input[key]);
	return chunks.join("\n");
}

function inputRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function block(ctx: ExtensionContext, reason: string): { block: true; reason: string } {
	if (ctx.hasUI) ctx.ui.notify(reason, "error");
	return { block: true, reason };
}

export default function sensitiveGuard(pi: ExtensionAPI): void {
	let config = loadConfig();
	const pending = new Set<string>();
	registerSensitiveGuardUI(pi, (next) => {
		config = next;
		pending.clear();
	});
	pi.on("session_start", () => {
		config = loadConfig();
		pending.clear();
	});
	pi.on("session_shutdown", () => pending.clear());

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled) return {};
		try {
			const input = inputRecord(event.input);
			const path = text(input.path);
			if (event.toolName === "read" || event.toolName === "grep") {
				const protectedPath = isProtectedPath(path, ctx.cwd, config);
				if (config.readRedaction.enabled && (protectedPath || config.readRedaction.scope === "allOutput")) {
					pending.add(event.toolCallId);
					return {};
				}
				return protectedPath ? block(ctx, "Sensitive Guard blocked a protected read.") : {};
			}

			if (event.toolName === "write" || event.toolName === "edit") {
				if (isProtectedPath(path, ctx.cwd, config)) return block(ctx, "Sensitive Guard blocked a protected write.");
				const content = event.toolName === "write" ? text(input.content) : replacementText(input);
				if (config.contentScanning.enabled) {
					const findings = scanSecrets(content, config.contentScanning.blockSeverity);
					if (findings.length)
						return block(ctx, `Sensitive Guard blocked secret-bearing content (${findings.join(", ")}).`);
				}
				return {};
			}

			if (event.toolName === "bash") {
				const command = text(input.command);
				if (await inspectGit(pi, command, ctx.cwd, config))
					return block(ctx, "Sensitive Guard blocked a git operation containing protected data.");
				const shell = inspectShell(command, ctx.cwd, config);
				if (shell.blocked) return block(ctx, "Sensitive Guard blocked a command targeting a protected path.");
				if (config.contentScanning.enabled && scanSecrets(command, config.contentScanning.blockSeverity).length) {
					return block(ctx, "Sensitive Guard blocked a command containing a secret.");
				}
				if (shell.protectedRead && !(config.readRedaction.enabled && config.readRedaction.includeShellOutput)) {
					return block(ctx, "Sensitive Guard blocked a protected shell read.");
				}
				if (
					config.readRedaction.enabled &&
					config.readRedaction.includeShellOutput &&
					(shell.protectedRead || config.readRedaction.scope === "allOutput")
				) {
					pending.add(event.toolCallId);
				}
			}
			return {};
		} catch {
			return block(ctx, "Sensitive Guard blocked the operation because its safety check failed.");
		}
	});

	pi.on("tool_result", (event) => {
		if (!pending.delete(event.toolCallId)) return {};
		const content = event.content.map((part) => {
			if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") return part;
			const item = part as { type: "text"; text: string; [key: string]: unknown };
			return { ...item, text: redactOutput(item.text, config.readRedaction) };
		});
		return { content };
	});
}

export { expandShellWord, inspectShell };
