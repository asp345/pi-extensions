import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ActiveTokenSpeed } from "./live-speed.ts";

const LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS = 1_000;
const MAX_REASONABLE_TOKEN_SPEED = 2_500;

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
	return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= MAX_REASONABLE_TOKEN_SPEED;
}

function estimateTokens(textLen: number): number {
	return Math.round(textLen / 4);
}

/** Cumulative usage totals and live streaming-speed state, rebuilt from session history on start. */
export class UsageAccountant {
	totalInput = 0;
	totalOutput = 0;
	totalCacheRead = 0;
	totalCacheWrite = 0;
	totalCost = 0;
	turnStartTime = 0;
	streaming = false;
	lastTokensPerSec = 0;
	lastLiveTokenSpeed: number | null = null;
	displayedLiveTokenSpeed: number | null = null;
	liveEstimatedTokens = 0;

	private lastSpeedDisplayAt = 0;
	private lastSpeedRenderRequestAt = 0;
	private liveOutputChars = 0;
	private liveUsageOutputTokens = 0;
	private accountedUsageKeys = new Set<string>();
	private speedTracker = new ActiveTokenSpeed();

	beginTurn(nowMs: number): void {
		this.turnStartTime = nowMs;
		this.streaming = false;
	}

	markStreaming(): void {
		this.streaming = true;
	}

	/** Account for one streaming delta; returns true when a footer render should be requested. */
	recordStreamDelta(deltaLength: number, usageOutputTokens: number | undefined, nowMs: number): boolean {
		this.streaming = true;
		this.liveOutputChars += deltaLength;

		let newTokens = 0;
		if (typeof usageOutputTokens === "number" && usageOutputTokens > this.liveUsageOutputTokens) {
			newTokens = usageOutputTokens - this.liveUsageOutputTokens;
			this.liveUsageOutputTokens = usageOutputTokens;
			this.liveEstimatedTokens = usageOutputTokens;
		} else if (this.liveUsageOutputTokens <= 0) {
			const estimated = estimateTokens(this.liveOutputChars);
			newTokens = Math.max(0, estimated - this.liveEstimatedTokens);
			this.liveEstimatedTokens = estimated;
		}
		if (newTokens > 0) this.speedTracker.add(newTokens, nowMs);

		if (nowMs - this.lastSpeedRenderRequestAt >= LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS) {
			this.lastSpeedRenderRequestAt = nowMs;
			return true;
		}
		return false;
	}

	/** Deduplicated usage accounting for one finished assistant message; returns true when recorded. */
	recordAssistantEnd(message: AssistantMessage, nowMs: number): boolean {
		const usage = message.usage;
		if (!usage) return false;

		// message_end and turn_end can report the same usage; deduplicate on a stable key.
		const usageKey =
			message.responseId || `${message.timestamp}:${message.provider}:${message.model}:${usage.input}:${usage.output}`;
		if (this.accountedUsageKeys.has(usageKey)) return false;
		this.accountedUsageKeys.add(usageKey);

		const totalElapsed = this.turnStartTime > 0 ? (nowMs - this.turnStartTime) / 1000 : 0;
		const tokensPerSec = totalElapsed >= 0.05 ? usage.output / totalElapsed : 0;
		const liveSpeed = this.speedTracker.getSpeed();

		this.lastTokensPerSec = tokensPerSec;
		this.lastLiveTokenSpeed = liveSpeed ?? this.lastLiveTokenSpeed;
		this.streaming = false;

		this.totalInput += usage.input;
		this.totalOutput += usage.output;
		this.totalCacheRead += usage.cacheRead;
		this.totalCacheWrite += usage.cacheWrite;
		this.totalCost += usage.cost?.total ?? 0;

		this.resetLiveState();
		return true;
	}

	endStreaming(): void {
		this.streaming = false;
		this.resetLiveState();
	}

	/** Refresh the displayed live speed at most once per second; returns the speed to display. */
	sampleDisplaySpeed(nowMs: number): number | null {
		let liveSpeed = this.displayedLiveTokenSpeed;
		if (this.streaming && nowMs - this.lastSpeedDisplayAt >= LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS) {
			const sampledSpeed = this.speedTracker.getSpeed();
			if (sampledSpeed !== null) this.displayedLiveTokenSpeed = sampledSpeed;
			this.lastSpeedDisplayAt = nowMs;
			liveSpeed = this.displayedLiveTokenSpeed;
		}
		return liveSpeed;
	}

	rebuildFromHistory(branch: SessionEntry[]): void {
		this.totalInput = 0;
		this.totalOutput = 0;
		this.totalCacheRead = 0;
		this.totalCacheWrite = 0;
		this.totalCost = 0;
		this.accountedUsageKeys = new Set();
		this.lastTokensPerSec = 0;

		let latestAssistantSpeed: number | null = null;

		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index];
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant" || !msg.usage) continue;

			this.totalInput += msg.usage.input ?? 0;
			this.totalOutput += msg.usage.output ?? 0;
			this.totalCacheRead += msg.usage.cacheRead ?? 0;
			this.totalCacheWrite += msg.usage.cacheWrite ?? 0;
			this.totalCost += msg.usage.cost?.total ?? 0;

			// Estimate speed from the preceding non-assistant message.
			if ((msg.usage.output ?? 0) <= 0) continue;
			const endMs = getEntryTimestampMs(entry);
			if (endMs === null) continue;

			for (let prevIndex = index - 1; prevIndex >= 0; prevIndex--) {
				const prev = branch[prevIndex];
				if (prev?.type !== "message") continue;
				const prevMsg = prev.message;
				if (prevMsg.role === "assistant") continue;

				const startMs = getEntryTimestampMs(prev);
				if (startMs === null || endMs <= startMs) continue;
				const elapsedSeconds = (endMs - startMs) / 1000;
				if (elapsedSeconds <= 0) continue;

				const speed = (msg.usage.output ?? 0) / elapsedSeconds;
				if (!isReasonableTokenSpeed(speed)) continue;

				if (prevMsg.role === "user") {
					latestAssistantSpeed = speed;
					break;
				}
				if (latestAssistantSpeed === null) latestAssistantSpeed = speed;
			}
		}

		if (latestAssistantSpeed !== null) this.lastTokensPerSec = latestAssistantSpeed;
	}

	private resetLiveState(): void {
		this.liveOutputChars = 0;
		this.liveEstimatedTokens = 0;
		this.liveUsageOutputTokens = 0;
		this.speedTracker.reset();
		this.displayedLiveTokenSpeed = null;
		this.lastSpeedDisplayAt = 0;
		this.lastSpeedRenderRequestAt = 0;
	}
}

function normalizeTimestampMs(timestamp: number): number {
	// Session timestamps mix seconds, milliseconds, and microseconds.
	if (timestamp < 1e11) return timestamp * 1000;
	if (timestamp > 1e14) return Math.floor(timestamp / 1000);
	return timestamp;
}

function getEntryTimestampMs(entry: {
	type: string;
	timestamp: string;
	message?: { timestamp?: number };
}): number | null {
	if (entry.type === "message" && typeof entry.message?.timestamp === "number") {
		return normalizeTimestampMs(entry.message.timestamp);
	}
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : null;
}
