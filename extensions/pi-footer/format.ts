import { homedir } from "node:os";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toFixed(1);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatTokenSpeed(tokensPerSecond: number): string {
	if (tokensPerSecond < 100) {
		if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
		return tokensPerSecond.toFixed(2);
	}
	if (tokensPerSecond < 1000) return Math.round(tokensPerSecond).toString();
	if (tokensPerSecond < 10000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
	if (tokensPerSecond < 1000000) return `${Math.round(tokensPerSecond / 1000)}k`;
	if (tokensPerSecond < 10000000) return `${(tokensPerSecond / 1000000).toFixed(1)}M`;
	return `${Math.round(tokensPerSecond / 1000000)}M`;
}

export function formatUserPath(cwd: string): string {
	const home = homedir();
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}
