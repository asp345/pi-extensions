import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCustomProvidersFile, writeCustomProvidersFile } from "./config.ts";
import { createProviderRegistrar } from "./runtime.ts";
import type { CustomProvidersFile } from "./types.ts";
import { runCustomProvidersUi } from "./ui.ts";

export default async function customProvidersExtension(pi: ExtensionAPI): Promise<void> {
	const registerProviders = createProviderRegistrar(pi);
	const startup = await readCustomProvidersFile().catch(() => undefined);
	if (startup) registerProviders(startup);

	pi.registerCommand("custom-providers", {
		description: "Configure custom providers",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/custom-providers requires an interactive UI", "error");
				return;
			}

			let data: CustomProvidersFile;
			try {
				data = await readCustomProvidersFile();
			} catch (error) {
				ctx.ui.notify(
					`Cannot read custom-providers.json: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			await runCustomProvidersUi(ctx, data, async (updated) => {
				try {
					await writeCustomProvidersFile(updated);
				} catch (error) {
					ctx.ui.notify(
						`Cannot save custom-providers.json: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				for (const problem of registerProviders(updated)) ctx.ui.notify(problem, "warning");
			});
		},
	});
}
