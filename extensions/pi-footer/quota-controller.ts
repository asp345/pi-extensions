import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCredential } from "./auth.ts";
import { resolveTokenPlan } from "./plans.ts";
import type { QuotaDisplay } from "./quota.ts";

export class QuotaController {
	state: QuotaDisplay | "no-data" | null = null;
	private ctx: ExtensionContext | null = null;
	private provider: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private version = 0;

	constructor(
		private readonly getTtl: () => number,
		private readonly requestRender: () => void,
	) {}

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.provider = ctx.model?.provider;
		this.state = null;
		this.restartTimer();
		void this.refresh();
	}

	stop(): void {
		this.version++;
		clearInterval(this.timer);
		this.ctx = null;
	}

	restartTimer(): void {
		clearInterval(this.timer);
		this.timer = setInterval(() => void this.refresh(), this.getTtl() * 1000);
	}

	setProvider(provider: string): void {
		if (provider === this.provider) return;
		this.provider = provider;
		this.state = null;
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return;
		const version = ++this.version;
		const plan = this.provider ? resolveTokenPlan(this.provider) : null;
		let state: QuotaDisplay | "no-data" | null = null;
		if (plan) {
			try {
				const credential = await resolveCredential(plan, ctx);
				state = credential ? (plan.format(await plan.fetch(credential, ctx.signal)) ?? "no-data") : "no-data";
			} catch {
				state = "no-data";
			}
		}
		if (version !== this.version) return;
		this.state = state;
		this.requestRender();
	}
}
