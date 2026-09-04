import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiStatsConfig } from "./config.ts";
import { resolveTokenPlan } from "./plans.ts";
import type { QuotaSegments, TeamCredential, TokenPlan } from "./quota.ts";

interface QuotaCacheEntry {
	fetchedAt: number;
	ttl: number;
	data: unknown;
}

type QuotaError =
	| { kind: "no_plan" }
	| { kind: "key_missing"; envVar: string; provider: string }
	| { kind: "api_error"; message: string }
	| { kind: "network_error"; message: string }
	| { kind: "no_data" };

interface QuotaDisplayState {
	planId: string;
	display: string;
	segments: QuotaSegments;
	modelPrefix: string;
	color: "ok" | "warn" | "err" | "muted";
	provider: string;
	fetchedAt: number;
	error?: QuotaError;
}

interface QuotaControllerOptions {
	getConfig(): PiStatsConfig;
	isSessionActive(): boolean;
	requestRender(): void;
}

export class QuotaController {
	private readonly cache: Record<string, QuotaCacheEntry> = {};
	private timer: ReturnType<typeof setInterval> | null = null;
	private provider: string | null = null;
	private refreshVersion = 0;
	state: QuotaDisplayState | null = null;

	constructor(private readonly options: QuotaControllerOptions) {}

	private resolvePlan(provider?: string): TokenPlan | null {
		if (!provider) return null;
		return resolveTokenPlan(provider, this.options.getConfig().providerPlans[provider]);
	}

	private resolveApiKey(plan: TokenPlan): string | null {
		if (plan.apiKeyEnv && process.env[plan.apiKeyEnv]) return process.env[plan.apiKeyEnv] ?? null;
		try {
			const authPath = join(getAgentDir(), "auth.json");
			if (!existsSync(authPath)) return null;
			const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { key?: string; access?: string }>;
			for (const providerId of plan.matchProviders) {
				const credential = auth[providerId]?.key ?? auth[providerId]?.access;
				if (credential) return credential;
			}
		} catch {
			return null;
		}
		return null;
	}

	private resolveTeamCredential(plan: TokenPlan): TeamCredential | null {
		if (plan.id !== "glm") return null;
		const team = this.options.getConfig().teamCredential;
		const organization = team?.organization.trim() ?? "";
		const project = team?.project.trim() ?? "";
		return organization && project ? { organization, project } : null;
	}

	private detectProvider(ctx: ExtensionContext): boolean {
		const provider = ctx.model?.provider ?? null;
		if (!provider) {
			this.provider = null;
			this.state = null;
			return false;
		}
		if (provider === this.provider) return false;
		this.provider = provider;
		this.state = null;
		return true;
	}

	private errorState(provider: string, planId: string, error: QuotaError): QuotaDisplayState {
		let display = "No quota data";
		if (error.kind === "key_missing") display = `❌ ${error.envVar} is not configured`;
		else if (error.kind === "api_error") display = `❌ ${truncate(error.message, 24)}`;
		else if (error.kind === "network_error") display = "❌ Network timeout";
		else if (error.kind === "no_plan") display = "Disabled";
		return { planId, provider, display, segments: {}, modelPrefix: "", color: "err", error, fetchedAt: Date.now() };
	}

	formatError(): string {
		const error = this.state?.error;
		if (!error) return "Unknown error";
		switch (error.kind) {
			case "no_plan":
				return "No quota plan configured for this provider";
			case "key_missing":
				return `Missing env var ${error.envVar} or credentials for ${error.provider} in ${join(getAgentDir(), "auth.json")}`;
			case "api_error":
				return `API error: ${error.message}`;
			case "network_error":
				return `Network timeout: ${error.message}`;
			case "no_data":
				return "API returned no data";
		}
	}

	async refresh(ctx: ExtensionContext, force = false): Promise<void> {
		this.detectProvider(ctx);
		const version = ++this.refreshVersion;
		const provider = ctx.model?.provider;
		if (!provider) return;
		const plan = this.resolvePlan(provider);
		if (!plan) {
			this.state = null;
			this.options.requestRender();
			return;
		}
		const key = plan.fetchQuotaWithContext ? null : this.resolveApiKey(plan);
		if (!plan.fetchQuotaWithContext && !key) {
			this.state = this.errorState(provider, plan.id, {
				kind: "key_missing",
				envVar: plan.apiKeyEnv || "API_KEY",
				provider,
			});
			this.options.requestRender();
			return;
		}
		const cached = this.cache[plan.id];
		const ttl = this.options.getConfig().ttl * 1000;
		if (!force && cached && Date.now() - cached.fetchedAt < cached.ttl) {
			this.state = { planId: plan.id, provider, ...plan.format(cached.data), fetchedAt: cached.fetchedAt };
			this.options.requestRender();
			return;
		}
		try {
			const data = plan.fetchQuotaWithContext
				? await plan.fetchQuotaWithContext(ctx)
				: await plan.fetchQuota(plan, key ?? "", { team: this.resolveTeamCredential(plan) });
			if (version !== this.refreshVersion || provider !== this.provider) return;
			this.cache[plan.id] = { fetchedAt: Date.now(), ttl, data };
			const formatted = plan.format(data);
			if (formatted.color === "err" && formatted.segments && Object.keys(formatted.segments).length === 0) {
				this.state = { ...this.errorState(provider, plan.id, { kind: "no_data" }), ...formatted };
			} else {
				this.state = { planId: plan.id, provider, ...formatted, fetchedAt: Date.now() };
			}
		} catch (error) {
			if (version !== this.refreshVersion || provider !== this.provider) return;
			const message = error instanceof Error ? error.message : String(error);
			const network = /timeout|abort|fetch failed|network|econnreset|enotfound/i.test(message);
			this.state = this.errorState(
				provider,
				plan.id,
				network ? { kind: "network_error", message } : { kind: "api_error", message },
			);
		}
		this.options.requestRender();
	}

	forceRefresh(ctx: ExtensionContext): Promise<void> {
		return this.refresh(ctx, true);
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
			if (!this.options.isSessionActive()) return;
			void this.forceRefresh(ctx).catch(() => {});
		}, 0);
	}

	restartTimer(ctx: ExtensionContext): void {
		this.stop();
		this.timer = setInterval(() => {
			if (!this.options.isSessionActive()) return;
			void this.refresh(ctx, ctx.model?.provider !== this.provider).catch(() => {});
		}, this.options.getConfig().ttl * 1000);
	}

	start(ctx: ExtensionContext): void {
		this.provider = null;
		this.refreshVersion += 1;
		this.state = null;
		for (const key of Object.keys(this.cache)) delete this.cache[key];
		this.restartTimer(ctx);
		void this.refresh(ctx).catch(() => {});
	}

	stop(): void {
		this.refreshVersion += 1;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
