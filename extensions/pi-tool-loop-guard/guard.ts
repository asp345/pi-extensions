const MAX_CONSECUTIVE = 3;

const LOOP_BLOCK_GUIDANCE =
	"Do not poll. Repeating it cannot produce a new result. Change the input or the approach, or end the turn.";

export function loopBlockReason(count: number): string {
	return `Blocked: identical tool call repeated ${count} times in a row. ${LOOP_BLOCK_GUIDANCE}`;
}

function callKey(toolName: string, input: unknown): string {
	return JSON.stringify([toolName, input ?? null]);
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
	private lastCall: string | null = null;
	private lastOutput: string | null = null;
	private chain = 0;

	shouldBlock(toolName: string, input: unknown): boolean {
		return this.chain >= MAX_CONSECUTIVE && this.lastCall === callKey(toolName, input);
	}

	chainLength(): number {
		return this.chain;
	}

	record(toolName: string, input: unknown, output: unknown): void {
		const call = callKey(toolName, input);
		const result = JSON.stringify(output ?? null);
		if (this.lastCall === call && this.lastOutput === result) {
			this.chain += 1;
		} else {
			this.lastCall = call;
			this.lastOutput = result;
			this.chain = 1;
		}
	}

	reset(): void {
		this.lastCall = null;
		this.lastOutput = null;
		this.chain = 0;
	}
}
