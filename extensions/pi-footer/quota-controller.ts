import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCredential } from "./auth.ts";
import { resolveTokenPlan } from "./plans.ts";
import type { QuotaDisplay } from "./quota.ts";

interface QuotaControllerOptions {
	getTtl(): number;
	isSessionActive(): boolean;
	requestRender(): void;
}

export class QuotaController {
	private readonly cache = new Map<string, { fetchedAt: number; data: unknown }>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private provider: string | null = null;
	private refreshVersion = 0;
	state: QuotaDisplay | "no-data" | null = null;

	constructor(private readonly options: QuotaControllerOptions) {}

	async refresh(ctx: ExtensionContext, force = false): Promise<void> {
		const provider = ctx.model?.provider ?? null;
		if (provider !== this.provider) {
			this.provider = provider;
			this.state = null;
		}
		const version = ++this.refreshVersion;
		const plan = provider ? resolveTokenPlan(provider) : null;
		if (!plan) {
			this.state = null;
			this.options.requestRender();
			return;
		}
		const cached = this.cache.get(plan.id);
		if (!force && cached && Date.now() - cached.fetchedAt < this.options.getTtl() * 1000) {
			this.state = plan.format(cached.data) ?? "no-data";
			this.options.requestRender();
			return;
		}
		try {
			const credential = await resolveCredential(plan, ctx);
			if (!credential) throw new Error(`Missing credentials for ${plan.id}`);
			const data = await plan.fetch(credential, ctx.signal);
			if (version !== this.refreshVersion || provider !== this.provider) return;
			this.cache.set(plan.id, { fetchedAt: Date.now(), data });
			this.state = plan.format(data) ?? "no-data";
		} catch {
			if (version !== this.refreshVersion || provider !== this.provider) return;
			this.state = "no-data";
		}
		this.options.requestRender();
	}

	handleProviderChange(ctx: ExtensionContext): void {
		const provider = ctx.model?.provider ?? null;
		if (provider === this.provider) return;
		this.provider = provider;
		this.refreshVersion += 1;
		this.state = null;
		if (!provider) {
			this.options.requestRender();
			return;
		}
		setTimeout(() => {
			if (this.options.isSessionActive()) void this.refresh(ctx, true);
		}, 0);
	}

	restartTimer(ctx: ExtensionContext): void {
		this.stop();
		this.timer = setInterval(() => {
			if (this.options.isSessionActive()) void this.refresh(ctx, ctx.model?.provider !== this.provider);
		}, this.options.getTtl() * 1000);
	}

	start(ctx: ExtensionContext): void {
		this.provider = null;
		this.refreshVersion += 1;
		this.state = null;
		this.cache.clear();
		this.restartTimer(ctx);
		void this.refresh(ctx);
	}

	stop(): void {
		this.refreshVersion += 1;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
