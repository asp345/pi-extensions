/**
 * Cline provider for pi.
 *
 * Registers Cline Pass and Cline Free models under one `cline-pass` provider
 * so both tiers use the same login credential. Free model ids receive a
 * `:free` suffix in the model picker; the suffix is removed before the
 * request reaches Cline, which rejects unknown model ids.
 *
 * Model metadata is loaded from the public Cline tier list and models.dev
 * catalog. Cline Free models have zero cost in pi.
 *
 * @module pi-clinepass-provider
 */

import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_API_KEY, PROVIDER_NAME, resolveApiBase } from "./env.js";
import { handleClineError } from "./error-handler.js";
import { resolveModels } from "./models.js";
import { login, getApiKey as oauthGetApiKey, refreshToken } from "./oauth.js";

const FREE_SUFFIX = ":free";

export default async function (pi: ExtensionAPI) {
	const apiBase = resolveApiBase();
	const models = await resolveModels({ apiBase });
	const envApiKey = process.env[ENV_API_KEY]?.trim();

	// Display id → Cline API id for suffixed free models. Requests must carry
	// the original id; Cline answers 404 for suffixed ids.
	const apiModelIds = new Map<string, string>();
	const freeModels = models.free.map((model) => {
		const id = model.id.endsWith(FREE_SUFFIX) ? model.id : `${model.id}${FREE_SUFFIX}`;
		apiModelIds.set(id, model.id);
		return { ...model, id };
	});

	const openaiCompletions = getApiProvider("openai-completions");
	if (!openaiCompletions) throw new Error("Missing openai-completions API provider");

	pi.registerProvider(PROVIDER_NAME, {
		name: "ClinePass",
		baseUrl: `${apiBase}/api/v1`,
		...(envApiKey ? { apiKey: `$${ENV_API_KEY}` } : {}),
		authHeader: true,
		api: "openai-completions",
		// Free-tier models are gated behind Cline's product-surface header.
		headers: { "x-client-type": "cline-cli" },
		oauth: {
			name: "ClinePass",
			login,
			refreshToken,
			getApiKey: oauthGetApiKey,
		},
		models: [...models.pass, ...freeModels].map((model) => ({
			...model,
			input: [...model.input],
		})),
		streamSimple: (model, context, options) => {
			const apiId = apiModelIds.get(model.id) ?? model.id;
			return openaiCompletions.streamSimple(apiId === model.id ? model : { ...model, id: apiId }, context, options);
		},
	});

	pi.on("message_end", handleClineError);
}
