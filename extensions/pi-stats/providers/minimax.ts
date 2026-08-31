import { formatTokenPlanDisplay, type TokenPlan } from "../quota.ts";

interface MiniMaxModelRemain {
	model_name?: unknown;
	current_interval_remaining_percent?: unknown;
	current_weekly_remaining_percent?: unknown;
	end_time?: unknown;
	weekly_end_time?: unknown;
}

interface MiniMaxResponse {
	base_resp?: {
		status_code?: unknown;
		status_msg?: unknown;
	};
	model_remains?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const minimaxQuotaPlan: TokenPlan = {
	id: "minimax",
	name: "MiniMax",
	matchProviders: ["minimax_local", "minimax-cn", "minimax"],
	apiKeyEnv: "MINIMAX_API_KEY",
	baseUrl: "https://api.minimaxi.com",
	quotaPath: "/v1/api/openplatform/coding_plan/remains",
	authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	fetchQuota: async (plan: TokenPlan, key: string) => {
		const url = `https://api.minimaxi.com${plan.quotaPath}`;
		const r = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});
		const data = (await r.json()) as MiniMaxResponse;
		if (data.base_resp?.status_code === 0) return data;
		const statusMessage =
			isRecord(data.base_resp) && typeof data.base_resp.status_msg === "string"
				? data.base_resp.status_msg
				: "MiniMax returned an error";
		throw new Error(statusMessage);
	},
	format: (data: unknown) => {
		const response = isRecord(data) ? data : {};
		const models = Array.isArray(response.model_remains)
			? response.model_remains.filter((model): model is MiniMaxModelRemain => isRecord(model))
			: [];
		const m =
			models.find((model) => model.model_name === "general") ||
			models.find((model) => typeof model.model_name === "string" && model.model_name.includes("M2")) ||
			models[0];
		if (!m) return { modelPrefix: "", display: "No data", segments: {}, color: "err" as const };
		const intervalRemaining =
			typeof m.current_interval_remaining_percent === "number" ? m.current_interval_remaining_percent : 0;
		const weeklyRemaining =
			typeof m.current_weekly_remaining_percent === "number" ? m.current_weekly_remaining_percent : 0;
		const now = Date.now();
		const resets = [m.end_time, m.weekly_end_time].filter(
			(time): time is number => typeof time === "number" && time > now,
		);
		const nearestReset = resets.length > 0 ? Math.min(...resets) : null;
		const formatted = formatTokenPlanDisplay(intervalRemaining, weeklyRemaining, nearestReset);
		return {
			modelPrefix: "",
			...formatted,
			color:
				intervalRemaining < 20 || weeklyRemaining < 20
					? ("err" as const)
					: intervalRemaining < 50 || weeklyRemaining < 50
						? ("warn" as const)
						: ("ok" as const),
		};
	},
};
