import type { QuotaPlan } from "../quota.ts";
import type { ResolvedCredential, UsageLimit, UsageWindow } from "../types.ts";
import { formatUsageLimits } from "./quota-adapter.ts";

const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
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
	return Math.min(1, Math.max(0, value));
}

function parseWindow(info: AntigravityQuotaInfo, descriptor: WindowDescriptor | undefined): UsageWindow | undefined {
	const resetAt = parseResetTime(info);
	if (!descriptor && resetAt === undefined) return undefined;
	return {
		id: descriptor?.id ?? info.windowId ?? "default",
		label: info.windowLabel ?? descriptor?.label ?? "Default",
		durationMs: descriptor?.durationMs,
		resetsAt: resetAt,
	};
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

async function fetchAntigravityUsage(credential: ResolvedCredential, signal?: AbortSignal): Promise<UsageLimit[]> {
	if (!credential.projectId) throw new Error("Missing Antigravity project id");
	const response = await fetch(`${ENDPOINT}${FETCH_AVAILABLE_MODELS_PATH}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credential.accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": userAgent(),
		},
		body: JSON.stringify({ project: credential.projectId }),
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = (await response.json()) as AntigravityUsageResponse;

	const nowMs = Date.now();
	const limits: UsageLimit[] = [];
	for (const modelInfo of Object.values(data.models ?? {})) {
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
		for (const quotaInfo of quotaInfos) {
			const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
			const windowId = window?.id ?? quotaInfo.windowId ?? "default";
			limits.push({
				id: `antigravity:${quotaInfo.tier ?? "default"}:${windowId}`,
				label: "Usage",
				window,
				remainingFraction: clampFraction(quotaInfo.remainingFraction) ?? (quotaInfo.resetTime ? 0 : undefined),
			});
		}
	}
	return limits;
}

export const antigravityQuotaPlan: QuotaPlan = {
	id: "antigravity",
	matchProviders: ["google-antigravity", "antigravity"],
	fetch: fetchAntigravityUsage,
	format: formatUsageLimits,
};
