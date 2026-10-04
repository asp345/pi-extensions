import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCredential } from "./auth.ts";
import { resolveTokenPlan } from "./plans.ts";
import type { QuotaDisplay, QuotaPlan } from "./quota.ts";

export class QuotaController {
	state: QuotaDisplay | "no-data" | null = null;
	private ctx: ExtensionContext | null = null;
	private provider: string | undefined;
	private modelId: string | undefined;
	private fetched: { plan: QuotaPlan; data: unknown } | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private version = 0;

	constructor(
		private readonly getTtl: () => number,
		private readonly requestRender: () => void,
	) {}

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.provider = ctx.model?.provider;
		this.modelId = ctx.model?.id;
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

	setModel(provider: string, modelId: string): void {
		const providerChanged = provider !== this.provider;
		this.provider = provider;
		this.modelId = modelId;
		if (providerChanged) {
			this.state = null;
			this.fetched = undefined;
			void this.refresh();
		} else if (this.fetched) {
			this.state = this.format(this.fetched.plan, this.fetched.data);
		}
	}

	private format(plan: QuotaPlan, data: unknown): QuotaDisplay | "no-data" {
		try {
			return plan.format(data, this.modelId) ?? "no-data";
		} catch {
			return "no-data";
		}
	}

	private async refresh(): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return;
		const version = ++this.version;
		const plan = this.provider ? resolveTokenPlan(this.provider) : null;
		let state: QuotaDisplay | "no-data" | null = null;
		let fetched: { plan: QuotaPlan; data: unknown } | undefined;
		if (plan) {
			try {
				const credential = await resolveCredential(plan, ctx);
				if (credential) fetched = { plan, data: await plan.fetch(credential, ctx.signal) };
			} catch {}
		}
		if (version !== this.version) return;
		if (plan) state = fetched ? this.format(plan, fetched.data) : "no-data";
		this.fetched = fetched;
		this.state = state;
		this.requestRender();
	}
}
