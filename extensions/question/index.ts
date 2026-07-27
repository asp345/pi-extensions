import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CUSTOM = "Type something";

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user to choose an option or enter an answer.",
		parameters: Type.Object({
			question: Type.String(),
			options: Type.Array(Type.String(), { minItems: 1 }),
		}),
		async execute(_id, { question, options }, _signal, _update, ctx) {
			if (ctx.mode !== "tui") return result("Interactive UI is unavailable.");

			const custom = options.includes(CUSTOM) ? `${CUSTOM}…` : CUSTOM;
			const choice = await ctx.ui.select(question, [...options, custom]);
			if (!choice) return result("User cancelled.");
			if (choice !== custom) return result(`User selected: ${choice}`);

			const answer = (await ctx.ui.input(question))?.trim();
			return result(answer ? `User answered: ${answer}` : "User cancelled.");
		},
	});
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}
