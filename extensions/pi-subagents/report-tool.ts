import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function reportToParent(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "report_to_parent",
		label: "Report to Parent",
		description:
			"Send a concise requested progress summary to the parent agent while this subagent continues working. Treat reported information as already delivered and do not repeat it in the final answer.",
		promptSnippet: "Report progress to the parent",
		promptGuidelines: [
			"After using report_to_parent, do not repeat previously reported information in the final answer. Include only new findings, final status, and unresolved issues since the latest report.",
		],
		parameters: Type.Object({
			summary: Type.String({ minLength: 1, maxLength: 4_000 }),
		}),
		async execute(_callId, _params) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Progress summary sent to the parent agent. Do not repeat reported information in the final answer; include only subsequent findings, final status, and unresolved issues.",
					},
				],
				details: {},
			};
		},
	});
}
