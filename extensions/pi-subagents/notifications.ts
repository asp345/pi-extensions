export class NotificationQueue<T> {
	private readonly pending = new Map<string, T>();
	private scheduled = false;

	constructor(private readonly deliver: (batch: ReadonlyMap<string, T>) => void) {}

	enqueue(id: string, value: T): void {
		this.pending.set(id, value);
		this.schedule();
	}

	delete(id: string): void {
		this.pending.delete(id);
	}

	clear(): void {
		this.pending.clear();
	}

	private schedule(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (!this.pending.size) return;
			const batch = new Map(this.pending);
			for (const [id, value] of batch) {
				if (this.pending.get(id) === value) this.pending.delete(id);
			}
			this.deliver(batch);
			if (this.pending.size) this.schedule();
		});
	}
}
