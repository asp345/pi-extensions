import { getJson, type QuotaPlan } from "../quota.ts";

interface DeepSeekBalanceInfo {
	currency?: unknown;
	total_balance?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const deepseekQuotaPlan: QuotaPlan = {
	id: "deepseek",
	matchProviders: ["deepseek-cn", "deepseek"],
	apiKeyEnv: "DEEPSEEK_API_KEY",
	fetch: ({ accessToken }) =>
		getJson("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${accessToken}` }),
	format: (data) => {
		const payload = isRecord(data) ? data : {};
		const infos = Array.isArray(payload.balance_infos)
			? payload.balance_infos.filter((info): info is DeepSeekBalanceInfo => isRecord(info))
			: [];
		const cny = infos.find((info) => info.currency === "CNY") || infos[0];
		if (!cny) return null;
		const total = parseFloat(String(cny.total_balance || "0"));
		return { segments: { balance: `¥${total.toFixed(1)}` }, color: total < 1 ? "warn" : "ok" };
	},
};
