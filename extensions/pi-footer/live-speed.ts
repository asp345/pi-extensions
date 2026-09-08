interface ActiveTokenSpeedOptions {
	activeWindowMs: number;
	idleGapMs: number;
	minimumActiveMs: number;
	maximumSamples: number;
	maximumSpeed: number;
}

interface TokenSample {
	timestampMs: number;
	tokens: number;
}

const DEFAULT_OPTIONS: ActiveTokenSpeedOptions = {
	activeWindowMs: 10_000,
	idleGapMs: 1_000,
	minimumActiveMs: 1_000,
	maximumSamples: 512,
	maximumSpeed: 1_000,
};

export class ActiveTokenSpeed {
	private readonly options: ActiveTokenSpeedOptions;
	private samples: TokenSample[] = [];

	constructor(options: Partial<ActiveTokenSpeedOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	add(tokens: number, timestampMs: number): void {
		if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(timestampMs)) return;
		this.samples.push({ timestampMs, tokens });
		if (this.samples.length > this.options.maximumSamples) this.samples.shift();
	}

	reset(): void {
		this.samples = [];
	}

	getSpeed(): number | null {
		if (this.samples.length < 2) return null;

		let activeMs = 0;
		let tokens = 0;
		for (let index = this.samples.length - 1; index > 0 && activeMs < this.options.activeWindowMs; index--) {
			const current = this.samples[index];
			const previous = this.samples[index - 1];
			if (!current || !previous) continue;
			const gapMs = current.timestampMs - previous.timestampMs;
			if (gapMs <= 0) continue;
			if (gapMs > this.options.idleGapMs) break;

			const includedMs = Math.min(gapMs, this.options.activeWindowMs - activeMs);
			tokens += current.tokens * (includedMs / gapMs);
			activeMs += includedMs;
		}
		if (activeMs < this.options.minimumActiveMs) return null;
		const speed = tokens / (activeMs / 1_000);
		return Number.isFinite(speed) && speed > 0 && speed <= this.options.maximumSpeed ? speed : null;
	}
}
