import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const MIN_GENERATION_SECONDS = 0.25;

export class UsageAccountant {
	lastTokensPerSec = 0;

	private firstDeltaAt = 0;
	private lastDeltaAt = 0;

	beginMessage(): void {
		this.firstDeltaAt = 0;
		this.lastDeltaAt = 0;
	}

	recordStreamDelta(nowMs: number): void {
		if (this.firstDeltaAt === 0) this.firstDeltaAt = nowMs;
		this.lastDeltaAt = nowMs;
	}

	recordAssistantEnd(message: AssistantMessage): void {
		const generationSeconds = (this.lastDeltaAt - this.firstDeltaAt) / 1000;
		if (this.firstDeltaAt > 0 && generationSeconds >= MIN_GENERATION_SECONDS) {
			this.lastTokensPerSec = message.usage.output / generationSeconds;
		}
		this.beginMessage();
	}

	restoreLastSpeed(branch: SessionEntry[]): void {
		this.lastTokensPerSec = 0;
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant" || msg.usage.output <= 0) continue;
			const startMs = normalizeTimestampMs(msg.timestamp);
			const endMs = Date.parse(entry.timestamp);
			if (!Number.isFinite(endMs) || endMs <= startMs) continue;
			this.lastTokensPerSec = msg.usage.output / ((endMs - startMs) / 1000);
		}
	}
}

function normalizeTimestampMs(timestamp: number): number {
	if (timestamp < 1e11) return timestamp * 1000;
	if (timestamp > 1e14) return Math.floor(timestamp / 1000);
	return timestamp;
}
