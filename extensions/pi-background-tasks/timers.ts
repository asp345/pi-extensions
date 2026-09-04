/** Timer storage for one managed task: heartbeat, timeout, and the deferred force-kill. */
export class TaskTimers {
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private force: ReturnType<typeof setTimeout> | undefined;
	timeout: ReturnType<typeof setTimeout> | undefined;

	armHeartbeat(ms: number, fn: () => void): void {
		this.heartbeat = setInterval(fn, ms);
		this.heartbeat.unref?.();
	}

	armTimeout(ms: number, fn: () => void): void {
		if (this.timeout) return;
		this.timeout = setTimeout(() => {
			this.timeout = undefined;
			fn();
		}, ms);
		this.timeout.unref?.();
	}

	armForce(fn: () => void): void {
		if (this.force) clearTimeout(this.force);
		this.force = setTimeout(() => {
			this.force = undefined;
			fn();
		}, 2_000);
		this.force.unref?.();
	}

	clearTimeout(): void {
		if (this.timeout) clearTimeout(this.timeout);
		this.timeout = undefined;
	}

	clearAll(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.force) clearTimeout(this.force);
		if (this.timeout) clearTimeout(this.timeout);
		this.heartbeat = undefined;
		this.force = undefined;
		this.timeout = undefined;
	}
}
