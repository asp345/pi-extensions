import type { ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const BUFFER_LIMIT = 120_000;

/** Per-task output capture: bounded in-memory ring plus a rotated log file. */
export class TaskOutput {
	text = "";
	outputBytes = 0;
	/** When false, append drops incoming data. The runtime wires this to task liveness. */
	isActive: () => boolean = () => false;
	private onRaw: ((data: Buffer) => void) | null;
	private readonly logFile: string;
	private readonly onAppend: (timestamp: number) => void;
	private readonly stdout = new StringDecoder("utf8");
	private readonly stderr = new StringDecoder("utf8");
	private logBytes = 0;

	constructor(logFile: string, onRaw: ((data: Buffer) => void) | null, onAppend: (timestamp: number) => void) {
		this.logFile = logFile;
		this.onRaw = onRaw;
		this.onAppend = onAppend;
		writeFileSync(logFile, "", "utf8");
	}

	attach(child: ChildProcess): void {
		child.stdout?.on("data", (data: Buffer) => {
			this.onRaw?.(data);
			this.append(this.stdout.write(data));
		});
		child.stderr?.on("data", (data: Buffer) => {
			this.onRaw?.(data);
			this.append(this.stderr.write(data));
		});
	}

	/** Drain the decoders and stop forwarding raw output; called when the task closes. */
	flush(): void {
		this.append(this.stdout.end());
		this.append(this.stderr.end());
		this.onRaw = null;
	}

	append(value: string): void {
		if (!value || !this.isActive()) return;
		this.outputBytes += Buffer.byteLength(value);
		this.text = `${this.text}${value}`.slice(-BUFFER_LIMIT);
		const now = Date.now();
		this.onAppend(now);
		try {
			appendFileSync(this.logFile, value, "utf8");
			this.logBytes += Buffer.byteLength(value);
			if (this.logBytes > BUFFER_LIMIT * 2) {
				writeFileSync(this.logFile, this.text, "utf8");
				this.logBytes = Buffer.byteLength(this.text);
			}
		} catch {}
	}
}
