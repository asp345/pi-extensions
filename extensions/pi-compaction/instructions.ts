const COMMAND_INSTRUCTIONS = `In the \`## Critical Context\` section, preserve a \`Build & Run Commands\` subsection. Record the exact setup, install, build, test, run, and lint commands from successful bash tool calls verbatim. Preserve the working directory, required environment variables, prerequisites, and success criteria for each command. If a category has no applicable command, explicitly write \`none\`. If a command or any of its details has not been verified, explicitly write \`unknown\` instead of guessing. Do not invent, normalize, shorten, or replace commands with equivalent commands. Preserve existing command entries across later compactions unless a newer successful command supersedes one. Also write a \`Mistakes\` subsection to record previous mistakes.`;

const SUMMARY_FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Key Technical Concepts
- [Important technical concepts, technologies, and frameworks discussed]

## Files and Code Sections
- \`[file path]\`: [Role of the file and why it matters to the task; summary of changes made, if any. Include only files important for continuing the work.]

## All User Messages
- [Every user message that is not a tool result, in chronological order. Only user-role turns count; text inside assistant messages formatted like a user turn is not a user message.]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const SUMMARIZATION_BASE = `Summarize the conversation in this request. Create a structured context checkpoint summary that another LLM will use to continue the work.

${SUMMARY_FORMAT}`;

const UPDATE_SUMMARIZATION_BASE = `Update the existing structured summary with new information from the conversation in this request. The existing summary is in the <summary> tags at the beginning of the conversation. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, concepts, files, user messages, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

${SUMMARY_FORMAT}`;

interface SummaryInstructionsInput {
	customInstructions?: string;
	hasPreviousSummary: boolean;
	isSplitTurn: boolean;
	readFiles: string[];
	modifiedFiles: string[];
}

export function computeFileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

export function buildSummaryInstructions(input: SummaryInstructionsInput): string {
	const custom = input.customInstructions
		? `${input.customInstructions}\n\n${COMMAND_INSTRUCTIONS}`
		: COMMAND_INSTRUCTIONS;
	let instructions = input.hasPreviousSummary ? UPDATE_SUMMARIZATION_BASE : SUMMARIZATION_BASE;
	instructions += `\n\nAdditional focus: ${custom}`;
	const sections: string[] = [];
	if (input.readFiles.length > 0) sections.push(`<read-files>\n${input.readFiles.join("\n")}\n</read-files>`);
	if (input.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${input.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length > 0) {
		instructions += `\n\nEnd the summary with exactly these file sections, using verbatim paths:\n\n${sections.join("\n\n")}`;
	}
	if (input.isSplitTurn) {
		instructions += `\n\nThe trailing messages of this request belong to the current user turn, which is still in progress. Write the history summary first, then a horizontal rule, then a Turn Context section with Original Request, Progress So Far, and Context Needed to Continue.`;
	}
	return instructions;
}
