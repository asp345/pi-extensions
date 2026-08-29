import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCodexCompaction from "./codex.ts";
import { type CompactionConfig, loadCompactionConfig } from "./config.ts";
import registerNativeMaterialization from "./native-materialize.ts";
import registerTextCompaction from "./text.ts";

export default function compaction(pi: ExtensionAPI): void {
	let config: CompactionConfig | undefined;
	let configError: unknown;
	const getConfig = (): CompactionConfig => {
		if (config) return config;
		throw configError ?? new Error("Compaction configuration is not loaded.");
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			config = loadCompactionConfig(ctx.cwd, ctx.isProjectTrusted());
			configError = undefined;
		} catch (error) {
			config = undefined;
			configError = error;
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	registerTextCompaction(pi, getConfig);
	registerNativeMaterialization(pi, getConfig);
	registerCodexCompaction(pi, getConfig);
}
