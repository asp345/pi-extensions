import { formatQuotaSegments, type QuotaSegments, type TokenPlan } from "../quota.ts";

interface DeepSeekBalanceInfo {
	currency?: unknown;
	total_balance?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const deepseekQuotaPlan: TokenPlan = {
	id: "deepseek",
	name: "DeepSeek",
	matchProviders: ["deepseek-cn", "deepseek"],
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseUrl: "https://api.deepseek.com",
	quotaPath: "/user/balance",
	authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	fetchQuota: async (plan: TokenPlan, key: string) => {
		const r = await fetch(plan.baseUrl + plan.quotaPath, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) throw new Error(`DeepSeek quota query HTTP ${r.status}`);
		return await r.json();
	},
	format: (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const infos = Array.isArray(payload.balance_infos)
			? payload.balance_infos.filter((info): info is DeepSeekBalanceInfo => isRecord(info))
			: [];
		const cny = infos.find((info) => info.currency === "CNY") || infos[0];
		if (!cny) return { modelPrefix: "", display: "No data", segments: {}, color: "err" as const };
		const total = parseFloat(String(cny.total_balance || "0"));
		const segments: QuotaSegments = { balance: `¥${total.toFixed(1)}` };
		return {
			modelPrefix: "",
			display: formatQuotaSegments(segments),
			segments,
			color: total < 1 ? ("warn" as const) : ("ok" as const),
		};
	},
};
