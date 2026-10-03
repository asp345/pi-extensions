import {
	createEditToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const flatEditSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to replace. It must match a unique region of the file." }),
	newText: Type.String({ description: "Replacement text." }),
});

function createFlatEditDefinition(cwd: string): ToolDefinition<typeof flatEditSchema, EditToolDetails | undefined> {
	const { name, label, constrainedSampling, execute } = createEditToolDefinition(cwd);
	return {
		name,
		label,
		constrainedSampling,
		description: "Edit a single file by replacing one exact, unique text region with new text.",
		promptSnippet: "Make a precise file edit by replacing one exact text region",
		promptGuidelines: [
			"Use edit for precise changes (oldText must match exactly)",
			"To change multiple locations, emit multiple edit calls in the same response. Calls on the same file are applied one at a time; do not make one call's oldText depend on another call's newText in the same response.",
			"Keep oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: flatEditSchema,
		execute: (toolCallId, { path, oldText, newText }, signal, onUpdate, ctx) =>
			execute(toolCallId, { path, edits: [{ oldText, newText }] }, signal, onUpdate, ctx),
	};
}

export default function flatEdit(pi: ExtensionAPI): void {
	pi.registerTool(createFlatEditDefinition(process.cwd()));
	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(createFlatEditDefinition(ctx.cwd));
	});
}
