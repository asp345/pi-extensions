import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ActiveTokenSpeed } from "./live-speed.ts";

const LIVE_TOKEN_SPEED_UPDATE_INTERVAL_MS = 1_000;
const MAX_REASONABLE_TOKEN_SPEED = 2_500;
const MAX_CALIBRATION_SAMPLES = 8;
// Ratios outside this range indicate a broken estimate or a usage anomaly; discard them.
const MIN_CALIBRATION_RATIO = 0.2;
const MAX_CALIBRATION_RATIO = 8;
// Minimum generated-text span before the per-message average is trusted over the turn elapsed time.
const MIN_GENERATION_SECONDS = 0.25;

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
	return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= MAX_REASONABLE_TOKEN_SPEED;
}

function isCjkCodePoint(codePoint: number): boolean {
	// Hangul, kana, CJK unified, and CJK compatibility blocks.
	return (
		(codePoint >= 0x1100 && codePoint <= 0x11ff) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff)
	);
}

/** CJK scripts tokenize at roughly one token per character; the rest at roughly four chars per token. */
function baseEstimateTokens(text: string): number {
	let cjkChars = 0;
	let otherChars = 0;
	for (const ch of text) {
		if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjkChars++;
		else otherChars++;
	}
	return Math.round(otherChars / 4 + cjkChars);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
	private liveUsageOutputTokens = 0;
	private accountedUsageKeys = new Set<string>();
	private speedTracker = new ActiveTokenSpeed();
	private calibrationRatios: number[] = [];
	private calibrationText = "";
	private currentResponseId: string | null = null;
	private firstDeltaAt = 0;
	private lastDeltaAt = 0;

	beginTurn(nowMs: number): void {
		this.turnStartTime = nowMs;
		this.streaming = false;
	}

	markStreaming(): void {
		this.streaming = true;
	}

	/** Account for one streaming delta; returns true when a footer render should be requested. */
	recordStreamDelta(
		deltaText: string,
		responseId: string | undefined,
		usageOutputTokens: number | undefined,
		nowMs: number,
	): boolean {
		this.streaming = true;
		if (typeof responseId === "string" && responseId !== this.currentResponseId) {
			this.currentResponseId = responseId;
			this.resetBurst();
		}
		if (this.firstDeltaAt === 0) this.firstDeltaAt = nowMs;
		this.lastDeltaAt = nowMs;
		this.calibrationText += deltaText;

		let newTokens = 0;
		if (typeof usageOutputTokens === "number" && usageOutputTokens > this.liveUsageOutputTokens) {
			newTokens = usageOutputTokens - this.liveUsageOutputTokens;
			this.liveUsageOutputTokens = usageOutputTokens;
			this.liveEstimatedTokens = usageOutputTokens;
		} else if (this.liveUsageOutputTokens <= 0) {
			const estimated = this.calibratedEstimate();
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

		// Prefer the pure generation window (first to last delta) so tool execution and TTFT are excluded.
		const generationSeconds =
			this.firstDeltaAt > 0 && this.lastDeltaAt > this.firstDeltaAt ? (this.lastDeltaAt - this.firstDeltaAt) / 1000 : 0;
		const tokensPerSec =
			generationSeconds >= MIN_GENERATION_SECONDS
				? usage.output / generationSeconds
				: this.turnElapsedTokensPerSec(usage.output, nowMs);
		const liveSpeed = this.speedTracker.getSpeed();

		this.recordCalibration(usage.output);
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

	private turnElapsedTokensPerSec(outputTokens: number, nowMs: number): number {
		const totalElapsed = this.turnStartTime > 0 ? (nowMs - this.turnStartTime) / 1000 : 0;
		return totalElapsed >= 0.05 ? outputTokens / totalElapsed : 0;
	}

	/** Correct future char-based estimates with the actual output size of finished messages. */
	private recordCalibration(actualOutputTokens: number): void {
		const baseEstimate = baseEstimateTokens(this.calibrationText);
		if (baseEstimate <= 0) return;
		const ratio = actualOutputTokens / baseEstimate;
		if (!Number.isFinite(ratio) || ratio < MIN_CALIBRATION_RATIO || ratio > MAX_CALIBRATION_RATIO) return;
		this.calibrationRatios.push(ratio);
		if (this.calibrationRatios.length > MAX_CALIBRATION_SAMPLES) this.calibrationRatios.shift();
	}

	private calibratedEstimate(): number {
		const base = baseEstimateTokens(this.calibrationText);
		const ratio = this.calibrationRatios.length > 0 ? median(this.calibrationRatios) : 1;
		return Math.round(base * ratio);
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

	/** Reset per-message streaming state without dropping the calibration history. */
	private resetBurst(): void {
		this.calibrationText = "";
		this.liveEstimatedTokens = 0;
		this.liveUsageOutputTokens = 0;
		this.firstDeltaAt = 0;
		this.lastDeltaAt = 0;
	}

	private resetLiveState(): void {
		this.currentResponseId = null;
		this.resetBurst();
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
