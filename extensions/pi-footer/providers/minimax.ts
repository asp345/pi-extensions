import { getJson, type QuotaPlan, quotaColor, quotaSegments } from "../quota.ts";

interface MiniMaxModelRemain {
	model_name?: unknown;
	current_interval_remaining_percent?: unknown;
	current_weekly_remaining_percent?: unknown;
	end_time?: unknown;
	weekly_end_time?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const minimaxQuotaPlan: QuotaPlan = {
	id: "minimax",
	matchProviders: ["minimax_local", "minimax-cn", "minimax"],
	apiKeyEnv: "MINIMAX_API_KEY",
	fetch: async ({ accessToken }) => {
		const data = await getJson("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains", {
			Authorization: `Bearer ${accessToken}`,
		});
		const status = isRecord(data) && isRecord(data.base_resp) ? data.base_resp : {};
		if (status.status_code === 0) return data;
		throw new Error(typeof status.status_msg === "string" ? status.status_msg : "MiniMax returned an error");
	},
	format: (data) => {
		const response = isRecord(data) ? data : {};
		const models = Array.isArray(response.model_remains)
			? response.model_remains.filter((model): model is MiniMaxModelRemain => isRecord(model))
			: [];
		const m =
			models.find((model) => model.model_name === "general") ||
			models.find((model) => typeof model.model_name === "string" && model.model_name.includes("M2")) ||
			models[0];
		if (!m) return null;
		const intervalRemaining =
			typeof m.current_interval_remaining_percent === "number" ? m.current_interval_remaining_percent : 0;
		const weeklyRemaining =
			typeof m.current_weekly_remaining_percent === "number" ? m.current_weekly_remaining_percent : 0;
		return {
			segments: quotaSegments({ fiveHour: intervalRemaining, week: weeklyRemaining }, [m.end_time, m.weekly_end_time]),
			color: quotaColor(intervalRemaining, weeklyRemaining),
		};
	},
};
