import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readModelsFile, writeModelsFile } from "./config.ts";
import openrouterMetadata from "./openrouter-metadata.ts";
import { createProviderRegistrar } from "./runtime.ts";
import type { ModelsFile } from "./types.ts";
import { runCustomModelUi } from "./ui.ts";

export default async function customModelExtension(pi: ExtensionAPI): Promise<void> {
	openrouterMetadata(pi);

	const registerProviders = createProviderRegistrar(pi);
	const startup = await readModelsFile().catch(() => undefined);
	if (startup) registerProviders(startup);

	pi.registerCommand("custom-model", {
		description: "Configure custom model providers and their models",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/custom-model requires an interactive UI", "error");
				return;
			}

			let data: ModelsFile;
			try {
				data = await readModelsFile();
			} catch (error) {
				ctx.ui.notify(`Cannot read models.json: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			await runCustomModelUi(ctx, data, async (updated) => {
				try {
					await writeModelsFile(updated);
				} catch (error) {
					ctx.ui.notify(`Cannot save models.json: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				for (const problem of registerProviders(updated)) ctx.ui.notify(problem, "warning");
			});
		},
	});
}
