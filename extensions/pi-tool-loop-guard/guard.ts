const MAX_CONSECUTIVE = 3;

export const LOOP_BLOCK_GUIDANCE =
	"Do not poll. Repeating it cannot produce a new result. Change the input or the approach, or end the turn.";

export function loopBlockReason(count: number): string {
	return `Blocked: identical tool call repeated ${count} times in a row. ${LOOP_BLOCK_GUIDANCE}`;
}

function inputKey(input: unknown): string {
	return JSON.stringify(input ?? null);
}

function outputKey(content: unknown): string {
	return JSON.stringify(content ?? null);
}

/**
 * Tracks the last completed tool call and how many consecutive completed calls
 * matched it on tool name, input, and output. record() runs in tool_result;
 * shouldBlock() runs in tool_call before the next execution, blocking only
 * when the finished chain already reached MAX_CONSECUTIVE identical calls. A
 * different name, input, or output restarts the count, and assistant text
 * output between calls resets it, so calls that still produce something new
 * are never blocked.
 */
export class LoopGuard {
	private lastName: string | null = null;
	private lastInput: string | null = null;
	private lastOutput: string | null = null;
	private chain = 0;

	shouldBlock(toolName: string, input: unknown): boolean {
		return this.chain >= MAX_CONSECUTIVE && this.lastName === toolName && this.lastInput === inputKey(input);
	}

	chainLength(): number {
		return this.chain;
	}

	record(toolName: string, input: unknown, output: unknown): void {
		const inputJSON = inputKey(input);
		const outputJSON = outputKey(output);
		if (this.lastName === toolName && this.lastInput === inputJSON && this.lastOutput === outputJSON) {
			this.chain += 1;
		} else {
			this.lastName = toolName;
			this.lastInput = inputJSON;
			this.lastOutput = outputJSON;
			this.chain = 1;
		}
	}

	reset(): void {
		this.lastName = null;
		this.lastInput = null;
		this.lastOutput = null;
		this.chain = 0;
	}
}
