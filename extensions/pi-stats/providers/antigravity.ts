import type {
	ResolvedCredential,
	UsageAmount,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../types.ts";
import { createProviderQuotaPlan } from "./quota-adapter.ts";

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

const ANTIGRAVITY_VERSION = "2.1.4";

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	dailyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	dailyQuotaInfos?: AntigravityQuotaInfo[];
	weeklyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	weeklyQuotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfoByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfosByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
}

interface WindowDescriptor {
	id: string;
	label: string;
	durationMs?: number;
}

function userAgent(): string {
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	return `antigravity/hub/${ANTIGRAVITY_VERSION} ${os}/${arch}`;
}

function classifyWindow(id: string | undefined, label: string | undefined): WindowDescriptor | undefined {
	const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
	if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
		return { id: "weekly", label: "Weekly", durationMs: ONE_WEEK_MS };
	}
	if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
		return { id: "daily", label: "Daily", durationMs: ONE_DAY_MS };
	}
	if (id || label) return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
	return undefined;
}

function parseResetTime(info: AntigravityQuotaInfo): number | undefined {
	const resetAt = info.resetTime ? Date.parse(info.resetTime) : undefined;
	return resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined;
}

function inferWindowFromReset(resetAt: number | undefined, nowMs: number): WindowDescriptor {
	if (resetAt !== undefined && resetAt - nowMs > ONE_DAY_MS) {
		return { id: "weekly", label: "Weekly", durationMs: ONE_WEEK_MS };
	}
	return { id: "daily", label: "Daily", durationMs: ONE_DAY_MS };
}

function quotaInferenceKey(info: AntigravityQuotaInfo): string {
	return [info.modelProvider ?? "", info.apiProvider ?? "", info.tier ?? ""].join("|");
}

function inferWindowDescriptors(
	quotaInfos: AntigravityQuotaInfo[],
	nowMs: number,
): Map<AntigravityQuotaInfo, WindowDescriptor> {
	const descriptors = new Map<AntigravityQuotaInfo, WindowDescriptor>();
	const groups = new Map<string, { info: AntigravityQuotaInfo; resetAt: number | undefined }[]>();

	for (const info of quotaInfos) {
		const explicitDescriptor = classifyWindow(info.windowId, info.windowLabel);
		if (explicitDescriptor) {
			descriptors.set(info, explicitDescriptor);
			continue;
		}
		const group = groups.get(quotaInferenceKey(info)) ?? [];
		group.push({ info, resetAt: parseResetTime(info) });
		groups.set(quotaInferenceKey(info), group);
	}

	for (const group of groups.values()) {
		const resetTimes = [
			...new Set(group.map((entry) => entry.resetAt).filter((r): r is number => r !== undefined)),
		].sort((a, b) => a - b);
		const latestReset = resetTimes.length > 1 ? resetTimes.at(-1) : undefined;
		for (const entry of group) {
			const descriptor =
				latestReset !== undefined && entry.resetAt === latestReset
					? { id: "weekly", label: "Weekly", durationMs: ONE_WEEK_MS }
					: inferWindowFromReset(entry.resetAt, nowMs);
			descriptors.set(entry.info, descriptor);
		}
	}

	return descriptors;
}

function withWindowDescriptor(
	info: AntigravityQuotaInfo,
	descriptor: WindowDescriptor | undefined,
): AntigravityQuotaInfo {
	if (!descriptor) return info;
	return {
		...info,
		windowId: info.windowId ?? descriptor.id,
		windowLabel: info.windowLabel ?? descriptor.label,
	};
}

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(info: AntigravityQuotaInfo, descriptor: WindowDescriptor | undefined): UsageWindow | undefined {
	const resetAt = parseResetTime(info);
	const hasResetAt = resetAt !== undefined;
	if (!descriptor && !hasResetAt) return undefined;
	return {
		id: descriptor?.id ?? info.windowId ?? "default",
		label: info.windowLabel ?? descriptor?.label ?? "Default",
		...(descriptor?.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
		...(hasResetAt ? { resetsAt: resetAt } : {}),
	};
}

function buildAmount(info: AntigravityQuotaInfo): UsageAmount {
	const apiRemainingFraction = clampFraction(info.remainingFraction);
	const remainingFraction = apiRemainingFraction ?? (info.resetTime ? 0 : undefined);
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = 1 - remainingFraction;
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction * 100;
	amount.limit = 100;
	return amount;
}

function formatCounterName(info: AntigravityQuotaInfo): string | undefined {
	switch (info.modelProvider ?? info.apiProvider) {
		case "MODEL_PROVIDER_ANTHROPIC":
		case "API_PROVIDER_ANTHROPIC_VERTEX":
			return "Anthropic";
		case "MODEL_PROVIDER_GOOGLE":
		case "API_PROVIDER_GOOGLE_GEMINI":
			return "Google";
		case "MODEL_PROVIDER_OPENAI":
		case "API_PROVIDER_OPENAI_VERTEX":
			return "OpenAI";
		default:
			return undefined;
	}
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const source = {
		...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
		...(info.modelProvider ? { modelProvider: info.modelProvider } : {}),
	};
	const addInfo = (value: AntigravityQuotaInfo, tier?: string, windowDescriptor?: WindowDescriptor) => {
		results.push({ ...source, ...withWindowDescriptor(value, windowDescriptor), ...(tier ? { tier } : {}) });
	};
	const addValue = (
		value: AntigravityQuotaInfo | AntigravityQuotaInfo[] | undefined,
		tier?: string,
		windowDescriptor?: WindowDescriptor,
	) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const entry of value) addInfo(entry, tier, windowDescriptor);
			return;
		}
		addInfo(value, tier, windowDescriptor);
	};

	addValue(info.quotaInfo);
	addValue(info.quotaInfos);
	addValue(info.dailyQuotaInfo, undefined, classifyWindow("daily", "Daily"));
	addValue(info.dailyQuotaInfos, undefined, classifyWindow("daily", "Daily"));
	addValue(info.weeklyQuotaInfo, undefined, classifyWindow("weekly", "Weekly"));
	addValue(info.weeklyQuotaInfos, undefined, classifyWindow("weekly", "Weekly"));

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) addValue(value, tier);
	}
	const addWindowMap = (values?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>) => {
		if (!values) return;
		for (const [windowId, value] of Object.entries(values))
			addValue(value, undefined, classifyWindow(windowId, undefined));
	};
	addWindowMap(info.quotaInfoByWindow);
	addWindowMap(info.quotaInfosByWindow);

	return results;
}

const antigravityUsageProvider: UsageProvider = {
	id: "antigravity",
	async fetchUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageReport | null> {
		if (!credential.projectId) return null;
		const nowMs = Date.now();

		const endpoints = [DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.sandbox.googleapis.com"];
		let response: Response | undefined;
		let successfulEndpoint = DEFAULT_ENDPOINT;
		for (const endpoint of endpoints) {
			try {
				const url = `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`;
				response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${credential.accessToken}`,
						"Content-Type": "application/json",
						"User-Agent": userAgent(),
					},
					body: JSON.stringify({ project: credential.projectId }),
					signal,
				});
				if (response.ok) {
					successfulEndpoint = endpoint;
					break;
				}
				if (response.status === 429 || (response.status >= 500 && response.status < 600)) continue;
				break;
			} catch (error) {
				if (endpoint === endpoints[endpoints.length - 1]) throw error;
			}
		}

		if (!response?.ok) return null;
		const data = (await response.json()) as AntigravityUsageResponse;

		const deduped = new Map<
			string,
			{
				amount: UsageAmount;
				window: UsageWindow | undefined;
				tier: string | undefined;
				windowId: string;
				counterName: string | undefined;
				counterKey: string;
			}
		>();

		for (const modelInfo of Object.values(data.models ?? {})) {
			const quotaInfos = normalizeQuotaInfos(modelInfo);
			const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
			for (const quotaInfo of quotaInfos) {
				const amount = buildAmount(quotaInfo);
				const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
				const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
				const counterName = formatCounterName(quotaInfo);
				const counterKey = counterName?.toLowerCase() ?? "default";
				const windowId = window?.id ?? quotaInfo.windowId ?? "default";
				const key = `${counterKey}|${tierKey}|${windowId}`;
				const existing = deduped.get(key);
				if (!existing) {
					deduped.set(key, { amount, window, tier: quotaInfo.tier, windowId, counterName, counterKey });
					continue;
				}
				const eFrac = existing.amount.remainingFraction;
				const cFrac = amount.remainingFraction;
				let bestAmount = existing.amount;
				let bestWindow = existing.window?.resetsAt ? existing.window : (window ?? existing.window);
				let bestTier = existing.tier ?? quotaInfo.tier;
				if (eFrac === undefined && cFrac !== undefined) {
					bestAmount = amount;
					bestTier = quotaInfo.tier ?? existing.tier;
				} else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
					bestAmount = amount;
					bestTier = quotaInfo.tier ?? existing.tier;
				}
				if (!bestWindow?.resetsAt && window?.resetsAt) bestWindow = window;
				deduped.set(key, {
					amount: bestAmount,
					window: bestWindow,
					tier: bestTier,
					windowId: existing.windowId,
					counterName: existing.counterName,
					counterKey: existing.counterKey,
				});
			}
		}

		const limits: UsageLimit[] = [];
		for (const entry of deduped.values()) {
			const label = entry.counterName ? `Usage (${entry.counterName})` : "Usage";
			limits.push({
				id: `antigravity:${entry.counterKey}:${entry.tier ?? "default"}:${entry.windowId}`,
				label,
				window: entry.window,
				amount: entry.amount,
				status: getUsageStatus(entry.amount.remainingFraction),
			});
		}

		limits.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));
		if (limits.length === 0) return null;
		const metadata: Record<string, unknown> = { endpoint: successfulEndpoint, projectId: credential.projectId };
		return { provider: "antigravity", fetchedAt: nowMs, limits, metadata };
	},
};

export const antigravityQuotaPlan = createProviderQuotaPlan({
	id: "antigravity",
	name: "Google Antigravity",
	matchProviders: ["google-antigravity", "antigravity"],
	apiKeyEnv: "GOOGLE_ANTIGRAVITY_ACCESS_TOKEN",
	provider: antigravityUsageProvider,
	credentialIds: ["google-antigravity", "antigravity"],
});
