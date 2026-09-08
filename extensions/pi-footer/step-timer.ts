// Tracks elapsed time for the current run in Pi's working message.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TICK_MS = 1000;
function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	}
	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function createStepTimer(pi: ExtensionAPI): void {
	let lastCtx: ExtensionContext | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;

	let runActive = false;
	let runStartMs = 0;

	function startTicker(): void {
		stopTicker();
		tick = setInterval(() => {
			if (!lastCtx?.hasUI || !runActive) return;
			lastCtx.ui.setWorkingMessage(`Working... ${formatDuration(Date.now() - runStartMs)}`);
		}, TICK_MS);
	}

	function stopTicker(): void {
		if (!tick) return;
		clearInterval(tick);
		tick = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		stopTicker();
		runActive = false;
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		if (runActive) return;
		runActive = true;
		runStartMs = Date.now();
		startTicker();
		if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage("Working... 00:00");
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		if (!runActive) return;
		if (lastCtx?.hasUI) lastCtx.ui.setWorkingMessage(); // Restore the default "Working..." message.
		runActive = false;
		stopTicker();
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		runActive = false;
		stopTicker();
		lastCtx = undefined;
	});
}
