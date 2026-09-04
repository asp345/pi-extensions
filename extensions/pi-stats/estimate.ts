export const MAX_REASONABLE_TOKEN_SPEED = 1000;

export function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
	return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= MAX_REASONABLE_TOKEN_SPEED;
}

export function estimateTokens(textLen: number): number {
	return Math.round(textLen / 4);
}
