import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { resolveTokenPlan, TOKEN_PLANS } from "./plans.ts";
import type { TeamCredential, TokenPlan } from "./quota.ts";

export interface SharedState {
	/** Whether the session is active. Set by session_start and session_shutdown. */
	sessionActive: boolean;
	/** Footer render callback, cleared when the footer or session closes. */
	requestRender: (() => void) | null;
	/** Reads token totals for one run from agent_start through agent_settled. */
	getRunStats?: () => RunTokenStats | null;
}

/** Token totals for one run, used by the step-timer summary. */
export interface RunTokenStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	/** Average output rate in tokens per second for the run. */
	tokensPerSec: number;
	/** Cache hit rate as a percentage. */
	cacheHitRate: number;
	/** Whether the run completed at least one message_end event. */
	hasData: boolean;
}

const DATA_DIR = join(getAgentDir(), "extensions", "pi-stats");
const LOGS_DIR = join(DATA_DIR, "logs");
const RAW_DIR = join(LOGS_DIR, "raw");
const HOURLY_DIR = join(LOGS_DIR, "hourly");
const DAILY_FILE = join(LOGS_DIR, "daily", "daily.jsonl");

const TOKEN_CONFIG_DIR = DATA_DIR;
const TOKEN_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "config.json");
const QUOTA_CACHE_FILE = join(LOGS_DIR, "quota-cache.json");
const DISPLAY_CONFIG_FILE = join(TOKEN_CONFIG_DIR, "display-config.json");

const LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS = 2000;
const MAX_REASONABLE_TOKEN_SPEED = 1000;

interface TurnStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokensPerSec: number;
	cacheHitRate: number;
	model: string;
	firstTokenLatency: number; // First-token latency in milliseconds
	wordCount: number; // Output word count: CJK characters plus words for other scripts
	cost: number; // Cost of this turn in USD
	liveTokenSpeed: number | null; // Streaming rolling-window speed
}

interface RawRecord extends TurnStats {
	ts: string;
	session: string;
}

interface HourlyRecord {
	date: string;
	hour: number;
	count: number;
	sumInput: number;
	sumOutput: number;
	sumCacheRead: number;
	sumCacheWrite: number;
	sumTokensPerSec: number;
	avgCacheHitRate: number;
}

interface DailyRecord {
	date: string;
	count: number;
	sumInput: number;
	sumOutput: number;
	sumCacheRead: number;
	sumCacheWrite: number;
	sumTokensPerSec: number;
	avgCacheHitRate: number;
}

interface TokenConfig {
	providerPlans: Record<string, string | null>;
	/** Optional GLM team credentials configured and persisted through /stats. */
	teamCredential?: { organization: string; project: string };
	ttl: number;
}

interface QuotaCache {
	[planId: string]: {
		fetchedAt: number;
		ttl: number;
		data: unknown;
	};
}

export type ContextStyle = "pct-window" | "used-window" | "pct" | "used" | "bar";
export type SpeedStyle = "t/s" | "tok/s" | "T/s" | "liveAt";

export type DisplayKey =
	| "input"
	| "output"
	| "totalTokens"
	| "cost"
	| "cacheHit"
	| "speed"
	| "context"
	| "quota5h"
	| "quotaDay"
	| "quotaWeek"
	| "quotaMonth"
	| "quotaBalance"
	| "quotaClock";
export interface DisplayConfig {
	items: Record<DisplayKey, boolean>;
	contextStyle: ContextStyle;
	speedStyle: SpeedStyle;
}

interface LiveTokenSample {
	timestampMs: number;
	tokens: number;
}

interface QuotaDisplayState {
	planId: string;
	display: string;
	modelPrefix: string;
	color: "ok" | "warn" | "err" | "muted";
	/** State belongs to this provider and is stale when it differs from ctx.model.provider. */
	provider: string;
	/** Fetch timestamp, used for freshness diagnostics. */
	fetchedAt: number;
	/** Detailed error for missing keys, API or network failures, or empty data. */
	error?: QuotaError;
}

type QuotaError =
	| { kind: "no_plan" }
	| { kind: "key_missing"; envVar: string; provider: string }
	| { kind: "api_error"; message: string }
	| { kind: "network_error"; message: string }
	| { kind: "no_data" };

/** Format token counts consistently with the token utility. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toFixed(1);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatTokenSpeed(tokensPerSecond: number): string {
	if (tokensPerSecond < 100) {
		if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
		return tokensPerSecond.toFixed(2);
	}
	if (tokensPerSecond < 1000) return Math.round(tokensPerSecond).toString();
	if (tokensPerSecond < 10000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
	if (tokensPerSecond < 1000000) return `${Math.round(tokensPerSecond / 1000)}k`;
	if (tokensPerSecond < 10000000) return `${(tokensPerSecond / 1000000).toFixed(1)}M`;
	return `${Math.round(tokensPerSecond / 1000000)}M`;
}

/**
 * Build GitHub-style markdown table source.
 *
 * `aligns` controls column alignment; `totalRow` adds a final total row.
 */
function renderTable(
	headers: string[],
	rows: string[][],
	opts?: {
		aligns?: Array<"left" | "right" | "center">;
		totalRow?: string[];
	},
): string[] {
	const aligns = opts?.aligns ?? [];
	// Escape cell pipes and newlines so the table structure remains valid.
	const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	const alignMark = (i: number) => {
		const a = aligns[i] ?? "left";
		return a === "right" ? "---:" : a === "center" ? ":---:" : "---";
	};

	const lines = [
		`| ${headers.map(esc).join(" | ")} |`,
		`| ${headers.map((_, i) => alignMark(i)).join(" | ")} |`,
		...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
	];
	if (opts?.totalRow) {
		lines.push(`| ${opts.totalRow.map(esc).join(" | ")} |`);
	}
	return lines;
}

/** Read raw records for the given dates. */
async function readRawRecordsForDates(dates: string[]): Promise<RawRecord[]> {
	const out: RawRecord[] = [];
	for (const d of dates) {
		try {
			const content = await readFile(join(RAW_DIR, `${d}.jsonl`), "utf-8");
			for (const line of content.trim().split("\n")) {
				if (line) out.push(JSON.parse(line));
			}
		} catch {}
	}
	return out;
}

/** Read raw records for the inclusive date range. */
async function readRawRecordsInRange(startDate: string, endDate: string): Promise<RawRecord[]> {
	const dates: string[] = [];
	try {
		const files = await readdir(RAW_DIR);
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const d = f.slice(0, 10);
			if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= startDate && d <= endDate) {
				dates.push(d);
			}
		}
	} catch {}
	return readRawRecordsForDates(dates);
}

interface ModelAgg {
	count: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	tokensPerSecSum: number;
	hitRateSum: number;
}

/** Render a per-model usage table sorted by total tokens. */
function renderModelBreakdown(records: RawRecord[]): string[] {
	if (records.length === 0) return ["", "> By model: no detail data in this range"];

	const byModel = new Map<string, ModelAgg>();
	for (const r of records) {
		const key = r.model || "unknown";
		const agg = byModel.get(key) ?? {
			count: 0,
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			tokensPerSecSum: 0,
			hitRateSum: 0,
		};
		agg.count++;
		agg.input += r.input;
		agg.cacheRead += r.cacheRead;
		agg.cacheWrite += r.cacheWrite;
		agg.output += r.output;
		agg.tokensPerSecSum += r.tokensPerSec;
		agg.hitRateSum += r.cacheHitRate;
		byModel.set(key, agg);
	}

	// Keep total-token accounting aligned with the summary: new input plus cached input.
	const totalTokensOf = (a: ModelAgg) => a.input + a.cacheRead + a.cacheWrite;
	const rows = [...byModel.entries()].sort((a, b) => totalTokensOf(b[1]) - totalTokensOf(a[1]));

	const total: ModelAgg = {
		count: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		tokensPerSecSum: 0,
		hitRateSum: 0,
	};
	const body: string[][] = rows.map(([model, agg]) => {
		total.count += agg.count;
		total.input += agg.input;
		total.cacheRead += agg.cacheRead;
		total.cacheWrite += agg.cacheWrite;
		total.output += agg.output;
		total.tokensPerSecSum += agg.tokensPerSecSum;
		total.hitRateSum += agg.hitRateSum;
		return [
			model,
			String(agg.count),
			formatTokens(agg.input),
			formatTokens(agg.cacheRead),
			formatTokens(agg.output),
			formatTokens(totalTokensOf(agg)),
			`${(agg.count > 0 ? agg.hitRateSum / agg.count : 0).toFixed(1)}%`,
			`${(agg.count > 0 ? agg.tokensPerSecSum / agg.count : 0).toFixed(1)}`,
		];
	});

	return [
		"",
		"**" + "By model" + "**",
		...renderTable(
			["Model", "Count", "New input", "Cached input", "Output", "Total tokens", "Hit rate", "Speed"],
			body,
			{
				aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
				totalRow: [
					"Total",
					String(total.count),
					formatTokens(total.input),
					formatTokens(total.cacheRead),
					formatTokens(total.output),
					formatTokens(total.input + total.cacheRead + total.cacheWrite),
					`${(total.count > 0 ? total.hitRateSum / total.count : 0).toFixed(1)}%`,
					`${(total.count > 0 ? total.tokensPerSecSum / total.count : 0).toFixed(1)}`,
				],
			},
		),
	];
}

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
	return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= MAX_REASONABLE_TOKEN_SPEED;
}

function estimateTokens(textLen: number): number {
	return Math.round(textLen / 4);
}

/** Extract plain text, including thinking blocks, from a message content array. */
function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content as unknown[]) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		const blockRecord = block as Record<string, unknown>;
		if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
			text += blockRecord.text;
		} else if (blockRecord.type === "thinking" && typeof blockRecord.thinking === "string") {
			text += blockRecord.thinking;
		}
	}
	return text;
}

/** Count CJK characters and whitespace-delimited words for other scripts. */
function countWords(text: string): number {
	if (!text) return 0;
	const pattern =
		/[a-zA-Z0-9_\u0392-\u03c9\u00c0-\u00ff\u0600-\u06ff\u0400-\u04ff]+|[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\uac00-\ud7af]+/g;
	const m = text.match(pattern);
	if (!m) return 0;
	let count = 0;
	for (let i = 0; i < m.length; i++) {
		if (m[i].charCodeAt(0) >= 0x4e00) {
			count += m[i].length;
		} else {
			count += 1;
		}
	}
	return count;
}

function getDateStr(ts = Date.now()): string {
	return new Date(ts).toISOString().slice(0, 10);
}

function getISO(ts = Date.now()): string {
	return new Date(ts).toISOString();
}

export function formatUserPath(cwd: string): string {
	const home = homedir();
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

const DEFAULT_TOKEN_CONFIG: TokenConfig = { providerPlans: {}, ttl: 60 };

const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
	items: {
		input: true,
		output: true,
		totalTokens: false,
		cost: true,
		cacheHit: true,
		speed: true,
		context: true,
		quota5h: true,
		quotaDay: true,
		quotaWeek: true,
		quotaMonth: true,
		quotaBalance: true,
		quotaClock: true,
	},
	contextStyle: "pct-window",
	speedStyle: "t/s",
};

export interface TokenStatsHandle {
	/** Status-bar metrics excluding run timing, which index.ts appends. */
	getMetricParts(theme: Theme, ctx: ExtensionContext): string[];
}

export function createTokenStats(pi: ExtensionAPI, shared: SharedState): TokenStatsHandle {
	const stats = {
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		turnCount: 0,
		turnStartTime: 0,
		firstTokenTime: 0,
		streaming: false,
		totalCacheHitRateSum: 0,
		lastInput: 0,
		lastOutput: 0,
		lastCacheRead: 0,
		lastCacheWrite: 0,
		lastCost: 0,
		lastCacheHitRate: 0,
		lastTokensPerSec: 0, // Average output rate
		lastLiveTokenSpeed: null as number | null, // Rolling-window speed
		lastFirstTokenLatency: 0, // First-token latency in milliseconds
		lastWordCount: 0, // Output word count
		liveOutputChars: 0,
		liveEstimatedTokens: 0,
		liveUsageOutputTokens: 0,
		liveTokenSamples: [] as LiveTokenSample[],
		// Deduplicate message_end and turn_end usage records.
		accountedUsageKeys: new Set<string>(),
	};

	let quotaState: QuotaDisplayState | null = null;
	let quotaTimerId: ReturnType<typeof setInterval> | null = null;
	let tokenConfig: TokenConfig | null = null;
	let lastQuotaProvider: string | null = null;

	let runStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		turns: 0,
	};
	let runStartMs = 0;
	let runLastMsgMs = 0;

	function resetRunStats(): void {
		runStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
		runStartMs = Date.now();
		runLastMsgMs = 0;
	}

	/** Read the current run totals; hasData is false when no turn completed. */
	function getRunStats(): RunTokenStats {
		if (runStats.turns === 0) {
			return { ...runStats, tokensPerSec: 0, cacheHitRate: 0, hasData: false };
		}
		const totalMs = runLastMsgMs - runStartMs;
		const tokensPerSec = totalMs >= 50 ? runStats.output / (totalMs / 1000) : 0;
		const totalPrompt = runStats.input + runStats.cacheRead + runStats.cacheWrite;
		const cacheHitRate = totalPrompt > 0 ? (runStats.cacheRead / totalPrompt) * 100 : 0;
		return { ...runStats, tokensPerSec, cacheHitRate, hasData: true };
	}

	shared.getRunStats = getRunStats;

	let displayConfig: DisplayConfig = {
		...DEFAULT_DISPLAY_CONFIG,
		items: { ...DEFAULT_DISPLAY_CONFIG.items },
	};

	function progressBar(pct: number, width = 8): string {
		const filled = Math.round((Math.min(pct, 100) / 100) * width);
		return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
	}

	function getRollingLiveTokenSpeed(nowMs: number = Date.now()): number | null {
		const cutoffMs = nowMs - LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS;
		stats.liveTokenSamples = stats.liveTokenSamples.filter((s) => s.timestampMs >= cutoffMs);
		if (stats.liveTokenSamples.length === 0) return null;

		const firstSample = stats.liveTokenSamples[0];
		if (!firstSample) return null;
		const firstSampleMs = firstSample.timestampMs;
		const windowStartMs = Math.max(stats.turnStartTime || firstSampleMs, cutoffMs);
		const elapsedSeconds = (nowMs - windowStartMs) / 1000;
		if (elapsedSeconds <= 0) return null;

		const tokens = stats.liveTokenSamples.reduce((sum, s) => sum + s.tokens, 0);
		const speed = tokens / elapsedSeconds;
		return isReasonableTokenSpeed(speed) ? speed : null;
	}

	function resetLiveState() {
		stats.liveOutputChars = 0;
		stats.liveEstimatedTokens = 0;
		stats.liveUsageOutputTokens = 0;
		stats.liveTokenSamples = [];
	}

	function getMetricParts(theme: Theme, ctx: ExtensionContext): string[] {
		const dim = (s: string) => theme.fg("dim", s);
		const warn = (s: string) => theme.fg("warning", s);
		const ok = dim;
		const muted = dim;

		const parts: string[] = [];
		const cfg = displayConfig.items;

		{
			const segParts: string[] = [];
			if (cfg.input) segParts.push(`↑${formatTokens(stats.totalInput)}`);
			if (cfg.output) segParts.push(`↓${formatTokens(stats.totalOutput)}`);
			if (cfg.totalTokens) {
				const total = stats.totalInput + stats.totalOutput;
				segParts.push(`Σ${formatTokens(total)}`);
			}
			if (cfg.cost) segParts.push(`$${stats.totalCost.toFixed(4)}`);
			if (cfg.cacheHit) {
				const totalPrompt = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
				const cumCH = totalPrompt > 0 ? (stats.totalCacheRead / totalPrompt) * 100 : 0;
				const chColor = dim;
				segParts.push(`${dim("CH")}${chColor(`${cumCH.toFixed(1)}%`)}`);
			}
			if (segParts.length > 0) parts.push(segParts.join(" "));
		}

		if (cfg.speed) {
			const liveSpeed = getRollingLiveTokenSpeed();
			const displaySpeed = liveSpeed !== null ? liveSpeed : stats.lastTokensPerSec;
			const speedNum = formatTokenSpeed(displaySpeed);
			const speedStyle = displayConfig.speedStyle ?? "t/s";
			switch (speedStyle) {
				case "tok/s":
					parts.push(`⚡${speedNum} tok/s`);
					break;
				case "T/s":
					parts.push(`⚡${speedNum} T/s`);
					break;
				case "liveAt":
					if (stats.streaming && liveSpeed !== null) {
						parts.push(`⚡${formatTokens(stats.liveEstimatedTokens)}@${speedNum}`);
					} else {
						parts.push(`⚡${speedNum} t/s`);
					}
					break;
				default:
					parts.push(`⚡${speedNum} t/s`);
					break;
			}
		}

		if (cfg.context) {
			try {
				const cu = ctx.getContextUsage();
				const ctxWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const ctxPercent = typeof cu?.percent === "number" ? cu.percent : null;
				const ctxUsed = ctxPercent !== null && ctxWindow > 0 ? Math.round((ctxWindow * ctxPercent) / 100) : 0;
				const ctxStyle = displayConfig.contextStyle ?? "pct-window";
				let ctxStr: string;
				if (ctxWindow > 0 && ctxPercent !== null) {
					switch (ctxStyle) {
						case "used-window":
							ctxStr = `${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`;
							break;
						case "pct":
							ctxStr = `${ctxPercent.toFixed(1)}%`;
							break;
						case "used":
							ctxStr = formatTokens(ctxUsed);
							break;
						case "bar":
							ctxStr = `${progressBar(ctxPercent)} ${ctxPercent.toFixed(1)}%`;
							break;
						default:
							ctxStr = `${ctxPercent.toFixed(1)}%/${formatTokens(ctxWindow)}`;
							break;
					}
				} else {
					ctxStr = ctxWindow > 0 ? `?/${formatTokens(ctxWindow)}` : `0%/0`;
				}
				const ctxColor =
					ctxPercent !== null && ctxWindow > 0
						? ctxPercent < 50
							? ok
							: ctxPercent < 65
								? (s: string) => theme.fg("accent", s)
								: ctxPercent < 75
									? muted
									: ctxPercent < 85
										? warn
										: (s: string) => theme.fg("error", s)
						: dim;
				parts.push(ctxColor(ctxStr));
			} catch {
				/* ignore */
			}
		}

		const curProvider = ctx.model?.provider ?? null;
		if (curProvider !== lastQuotaProvider) {
			// Provider changes force a refresh and bypass the quota cache.
			if (lastQuotaProvider !== null || curProvider !== null) {
				setTimeout(() => {
					if (!shared.sessionActive) return;
					refreshQuota(ctx, true)
						.then(() => shared.requestRender?.())
						.catch(() => {
							/* Ignore stale session contexts. */
						});
				}, 0);
			}
			lastQuotaProvider = curProvider;
		}
		if (quotaState?.display) {
			const qColor =
				quotaState.color === "ok"
					? ok
					: quotaState.color === "warn"
						? warn
						: quotaState.color === "err"
							? (s: string) => theme.fg("error", s)
							: muted;
			const prefix = quotaState.modelPrefix ? `${quotaState.modelPrefix} ` : "";

			// Show the error text instead of hiding a failed quota state.
			if (quotaState.error) {
				parts.push(qColor(prefix + quotaState.display));
			} else {
				// Filter the normal display by the enabled quota items.
				const fullDisplay = quotaState.display;
				const filteredParts: string[] = [];
				if (cfg.quota5h) {
					const match = fullDisplay.match(/\b5h:\s+\d+%/);
					if (match) filteredParts.push(match[0]);
				}
				if (cfg.quotaDay) {
					const match = fullDisplay.match(/\bD:\s+\d+%/);
					if (match) filteredParts.push(match[0]);
				}
				if (cfg.quotaWeek) {
					const match = fullDisplay.match(/\bW:\s+\d+%/);
					if (match) filteredParts.push(match[0]);
				}
				if (cfg.quotaMonth) {
					const match = fullDisplay.match(/\bM:\s+\d+%/);
					if (match) filteredParts.push(match[0]);
				}
				if (cfg.quotaBalance) {
					const match = fullDisplay.match(/(?:\bB:\s*)?[¥$]\d+(?:\.\d+)?/);
					if (match) filteredParts.push(match[0]);
				}
				if (cfg.quotaClock) {
					const match = fullDisplay.match(/⏱\s*\d+[wdhm](?:\s+\d+[dhm])?/);
					if (match) filteredParts.push(match[0]);
				}
				if (filteredParts.length > 0) {
					parts.push(qColor(prefix + filteredParts.join(" ")));
				}
			}
		}

		return parts.map((part) => theme.fg("dim", part));
	}

	async function ensureDir(dir: string) {
		await mkdir(dir, { recursive: true });
	}

	async function appendRaw(record: RawRecord) {
		await ensureDir(RAW_DIR);
		const file = join(RAW_DIR, `${record.ts.slice(0, 10)}.jsonl`);
		await appendFile(file, `${JSON.stringify(record)}\n`, "utf-8");
	}

	async function updateHourly(record: RawRecord) {
		await ensureDir(HOURLY_DIR);
		const date = record.ts.slice(0, 10);
		const hour = new Date(record.ts).getHours();
		const file = join(HOURLY_DIR, `${date}.jsonl`);

		let lines: string[] = [];
		try {
			lines = (await readFile(file, "utf-8")).trim().split("\n").filter(Boolean);
		} catch {}

		const records: HourlyRecord[] = lines.map((l) => JSON.parse(l));
		const idx = records.findIndex((r) => r.date === date && r.hour === hour);

		if (idx >= 0) {
			const r = records[idx];
			const newCount = r.count + 1;
			records[idx] = {
				date,
				hour,
				count: newCount,
				sumInput: r.sumInput + record.input,
				sumOutput: r.sumOutput + record.output,
				sumCacheRead: r.sumCacheRead + record.cacheRead,
				sumCacheWrite: r.sumCacheWrite + record.cacheWrite,
				sumTokensPerSec: r.sumTokensPerSec + record.tokensPerSec,
				avgCacheHitRate: (r.avgCacheHitRate * r.count + record.cacheHitRate) / newCount,
			};
		} else {
			records.push({
				date,
				hour,
				count: 1,
				sumInput: record.input,
				sumOutput: record.output,
				sumCacheRead: record.cacheRead,
				sumCacheWrite: record.cacheWrite,
				sumTokensPerSec: record.tokensPerSec,
				avgCacheHitRate: record.cacheHitRate,
			});
		}

		await writeFile(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
	}

	async function updateDaily(record: RawRecord) {
		await ensureDir(join(LOGS_DIR, "daily"));
		const date = record.ts.slice(0, 10);

		let lines: string[] = [];
		try {
			lines = (await readFile(DAILY_FILE, "utf-8")).trim().split("\n").filter(Boolean);
		} catch {}

		const records: DailyRecord[] = lines.map((l) => JSON.parse(l));
		const idx = records.findIndex((r) => r.date === date);

		if (idx >= 0) {
			const r = records[idx];
			const newCount = r.count + 1;
			records[idx] = {
				date,
				count: newCount,
				sumInput: r.sumInput + record.input,
				sumOutput: r.sumOutput + record.output,
				sumCacheRead: r.sumCacheRead + record.cacheRead,
				sumCacheWrite: r.sumCacheWrite + record.cacheWrite,
				sumTokensPerSec: r.sumTokensPerSec + record.tokensPerSec,
				avgCacheHitRate: (r.avgCacheHitRate * r.count + record.cacheHitRate) / newCount,
			};
		} else {
			records.push({
				date,
				count: 1,
				sumInput: record.input,
				sumOutput: record.output,
				sumCacheRead: record.cacheRead,
				sumCacheWrite: record.cacheWrite,
				sumTokensPerSec: record.tokensPerSec,
				avgCacheHitRate: record.cacheHitRate,
			});
		}

		await writeFile(DAILY_FILE, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
	}

	async function persistTurn(record: TurnStats, sessionId: string) {
		const raw: RawRecord = {
			...record,
			ts: getISO(),
			session: sessionId,
		};
		await appendRaw(raw);
		await updateHourly(raw);
		await updateDaily(raw);
	}

	function normalizeTimestampMs(timestamp: number): number {
		// Normalize mixed timestamp units to milliseconds.
		if (timestamp < 1e11) return timestamp * 1000; // seconds → ms
		if (timestamp > 1e14) return Math.floor(timestamp / 1000); // microsec → ms
		return timestamp;
	}

	function getEntryTimestampMs(entry: {
		type: string;
		timestamp: string;
		message?: { timestamp?: number };
	}): number | null {
		if (entry.type === "message" && typeof entry.message?.timestamp === "number") {
			return normalizeTimestampMs(entry.message.timestamp);
		}
		const parsed = Date.parse(entry.timestamp);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function rebuildFromHistory(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		stats.totalInput = 0;
		stats.totalOutput = 0;
		stats.totalCacheRead = 0;
		stats.totalCacheWrite = 0;
		stats.totalCost = 0;
		stats.totalCacheHitRateSum = 0;
		stats.turnCount = 0;
		stats.accountedUsageKeys = new Set();
		stats.lastTokensPerSec = 0;

		// Rebuild cumulative totals and estimate historical speed.
		let latestAssistantSpeed: number | null = null;

		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant" || !msg.usage) continue;

			stats.totalInput += msg.usage.input ?? 0;
			stats.totalOutput += msg.usage.output ?? 0;
			stats.totalCacheRead += msg.usage.cacheRead ?? 0;
			stats.totalCacheWrite += msg.usage.cacheWrite ?? 0;
			stats.totalCost += msg.usage.cost?.total ?? 0;

			const promptTokens = (msg.usage.input ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0);
			const chRate = promptTokens > 0 ? ((msg.usage.cacheRead ?? 0) / promptTokens) * 100 : 0;
			stats.totalCacheHitRateSum += chRate;
			stats.turnCount++;

			// Estimate speed from the preceding non-assistant message.
			if ((msg.usage.output ?? 0) <= 0) continue;
			const endMs = getEntryTimestampMs(entry);
			if (endMs === null) continue;

			for (let j = branch.indexOf(entry) - 1; j >= 0; j--) {
				const prev = branch[j];
				if (prev.type !== "message") continue;
				const prevMsg = prev.message;
				if (prevMsg.role === "assistant") continue; // Skip assistant-to-assistant deltas.

				const startMs = getEntryTimestampMs(prev);
				if (startMs === null || endMs <= startMs) continue;

				const elapsedSeconds = (endMs - startMs) / 1000;
				if (elapsedSeconds <= 0) continue;

				const speed = (msg.usage.output ?? 0) / elapsedSeconds;
				if (!isReasonableTokenSpeed(speed)) continue;

				if (prevMsg.role === "user") {
					latestAssistantSpeed = speed;
					break;
				}
				// Fall back to non-user messages.
				if (latestAssistantSpeed === null) latestAssistantSpeed = speed;
			}
		}

		if (latestAssistantSpeed !== null) {
			stats.lastTokensPerSec = latestAssistantSpeed;
		}
	}

	async function loadTokenConfig(): Promise<TokenConfig> {
		try {
			if (existsSync(TOKEN_CONFIG_FILE)) {
				const raw = await readFile(TOKEN_CONFIG_FILE, "utf-8");
				return { ...DEFAULT_TOKEN_CONFIG, ...JSON.parse(raw) };
			}
		} catch {}
		return { ...DEFAULT_TOKEN_CONFIG };
	}

	async function saveTokenConfig(cfg: TokenConfig) {
		await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
		await writeFile(TOKEN_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
	}

	function isContextStyle(v: unknown): v is ContextStyle {
		return typeof v === "string" && ["pct-window", "used-window", "pct", "used", "bar"].includes(v);
	}
	function isSpeedStyle(v: unknown): v is SpeedStyle {
		return typeof v === "string" && ["t/s", "tok/s", "T/s", "liveAt"].includes(v);
	}

	async function loadDisplayConfig(): Promise<DisplayConfig> {
		try {
			if (existsSync(DISPLAY_CONFIG_FILE)) {
				const raw = await readFile(DISPLAY_CONFIG_FILE, "utf-8");
				const saved = JSON.parse(raw) as DisplayConfig;
				// Merge with defaults so newly added display items remain enabled.
				const merged: DisplayConfig = {
					...DEFAULT_DISPLAY_CONFIG,
					items: { ...DEFAULT_DISPLAY_CONFIG.items },
				};
				if (saved.items) {
					for (const key of Object.keys(merged.items) as DisplayKey[]) {
						if (typeof saved.items[key] === "boolean") merged.items[key] = saved.items[key];
					}
				}
				if (isContextStyle(saved.contextStyle)) merged.contextStyle = saved.contextStyle;
				if (isSpeedStyle(saved.speedStyle)) merged.speedStyle = saved.speedStyle;
				return merged;
			}
		} catch {}
		return { ...DEFAULT_DISPLAY_CONFIG, items: { ...DEFAULT_DISPLAY_CONFIG.items } };
	}

	async function saveDisplayConfig(cfg: DisplayConfig) {
		await mkdir(TOKEN_CONFIG_DIR, { recursive: true });
		await writeFile(DISPLAY_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
	}

	async function readQuotaCache(): Promise<QuotaCache> {
		try {
			if (existsSync(QUOTA_CACHE_FILE)) {
				const raw = await readFile(QUOTA_CACHE_FILE, "utf-8");
				return JSON.parse(raw);
			}
		} catch {}
		return {};
	}

	async function writeQuotaCache(cache: QuotaCache) {
		await ensureDir(LOGS_DIR);
		await writeFile(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
	}

	function resolveActivePlan(provider?: string): TokenPlan | null {
		if (!tokenConfig || !provider) return null;
		return resolveTokenPlan(provider, tokenConfig.providerPlans[provider]);
	}

	function resolveApiKey(plan: TokenPlan): string | null {
		if (plan.apiKeyEnv && process.env[plan.apiKeyEnv]) return process.env[plan.apiKeyEnv] ?? null;
		try {
			const authPath = join(getAgentDir(), "auth.json");
			if (!existsSync(authPath)) return null;
			const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { key?: string; access?: string }>;
			for (const providerId of plan.matchProviders) {
				const entry = auth[providerId];
				const credential = entry?.key ?? entry?.access;
				if (credential) return credential;
			}
		} catch {}
		return null;
	}

	/**
	 * Return complete GLM team credentials, or null to use the personal query.
	 * Both organization and project IDs are required.
	 */
	function resolveTeamCredential(plan: TokenPlan): TeamCredential | null {
		if (plan.id !== "glm") return null;
		const tc = tokenConfig?.teamCredential;
		const organization = tc?.organization?.trim() ?? "";
		const project = tc?.project?.trim() ?? "";
		if (organization && project) return { organization, project };
		return null;
	}

	/** Detect a provider change and clear stale quota state. */
	function detectAndHandleProviderChange(ctx: ExtensionContext): boolean {
		const curProvider = ctx.model?.provider ?? null;
		if (!curProvider) {
			// No provider means no quota state and no refresh.
			if (quotaState) quotaState = null;
			lastQuotaProvider = null;
			return false;
		}
		if (curProvider === lastQuotaProvider) return false;
		// Record the new provider before clearing the old state.
		lastQuotaProvider = curProvider;
		quotaState = null;
		return true;
	}

	function buildErrorState(provider: string, planId: string, error: QuotaError): QuotaDisplayState {
		let display = "No quota data";
		if (error.kind === "key_missing") {
			display = `❌ ${error.envVar} is not configured`;
		} else if (error.kind === "api_error") {
			display = `❌ ${truncateText(error.message, 24)}`;
		} else if (error.kind === "network_error") {
			display = "❌ Network timeout";
		} else if (error.kind === "no_plan") {
			display = "Disabled";
		}
		return {
			planId,
			provider,
			display,
			modelPrefix: "",
			color: "err",
			error,
			fetchedAt: Date.now(),
		};
	}

	function truncateText(s: string, max: number): string {
		if (s.length <= max) return s;
		return `${s.slice(0, max - 1)}…`;
	}

	/** Format a quota error for user-facing status messages. */
	function formatQuotaError(state: QuotaDisplayState | null | undefined): string {
		if (!state?.error) return "Unknown error";
		const e = state.error;
		switch (e.kind) {
			case "no_plan":
				return "No quota plan configured for this provider";
			case "key_missing":
				return `Missing env var ${e.envVar} or credentials for ${e.provider} in ${join(getAgentDir(), "auth.json")}`;
			case "api_error":
				return `API ${"error"}: ${e.message}`;
			case "network_error":
				return `${"Network timeout"}: ${e.message}`;
			case "no_data":
				return "API returned no data";
		}
	}

	async function refreshQuota(ctx: ExtensionContext, force = false): Promise<void> {
		detectAndHandleProviderChange(ctx);

		const curProvider = ctx.model?.provider;
		if (!curProvider) return;
		const plan = resolveActivePlan(curProvider);
		if (!plan) {
			quotaState = null;
			return;
		}
		const key = plan.fetchQuotaWithContext ? null : resolveApiKey(plan);
		if (!plan.fetchQuotaWithContext && !key) {
			quotaState = buildErrorState(curProvider, plan.id, {
				kind: "key_missing",
				envVar: plan.apiKeyEnv || "API_KEY",
				provider: curProvider,
			});
			return;
		}
		// Read the cache unless force is set.
		const cache = await readQuotaCache();
		const cached = cache[plan.id];
		const ttlMs = (tokenConfig?.ttl || 60) * 1000;
		if (!force && cached && Date.now() - cached.fetchedAt < cached.ttl) {
			const fmt = plan.format(cached.data);
			quotaState = {
				planId: plan.id,
				provider: curProvider,
				display: fmt.display,
				modelPrefix: fmt.modelPrefix,
				color: fmt.color,
				fetchedAt: cached.fetchedAt,
			};
			shared.requestRender?.();
			return;
		}

		try {
			const data = plan.fetchQuotaWithContext
				? await plan.fetchQuotaWithContext(ctx)
				: await plan.fetchQuota(plan, key ?? "", { team: resolveTeamCredential(plan) });
			cache[plan.id] = { fetchedAt: Date.now(), ttl: ttlMs, data };
			await writeQuotaCache(cache);
			const fmt = plan.format(data);
			if (fmt.color === "err" && fmt.display === "No quota data") {
				quotaState = buildErrorState(curProvider, plan.id, { kind: "no_data" });
				quotaState.display = fmt.display;
				quotaState.modelPrefix = fmt.modelPrefix;
				return;
			}
			quotaState = {
				planId: plan.id,
				provider: curProvider,
				display: fmt.display,
				modelPrefix: fmt.modelPrefix,
				color: fmt.color,
				fetchedAt: Date.now(),
			};
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			const isNetwork = /timeout|abort|fetch failed|network|econnreset|enotfound/i.test(msg);
			quotaState = buildErrorState(
				curProvider,
				plan.id,
				isNetwork ? { kind: "network_error", message: msg } : { kind: "api_error", message: msg },
			);
		}
		shared.requestRender?.();
	}

	async function forceRefreshQuota(ctx: ExtensionContext) {
		await refreshQuota(ctx, true);
		shared.requestRender?.();
	}

	/** Return the base config shape when no config has been loaded. */
	function baseTokenConfig(): TokenConfig {
		return { ...(tokenConfig ?? { providerPlans: {}, ttl: 60 }) };
	}

	/**
	 * Prompt for GLM team credentials, persist them, then force a team quota refresh.
	 */
	async function promptGlmTeamConfig(ctx: ExtensionContext): Promise<void> {
		const cur = tokenConfig?.teamCredential;
		const curLabel =
			cur?.organization && cur?.project ? `${cur.organization} / ${cur.project}` : "not configured (personal query)";
		const prompts = ["✏️ Configure / Edit", "Skip"];
		const choice = await ctx.ui.select(
			`GLM team plan credentials? Current: ${curLabel}\nEnter organization and project IDs for a team query, or skip for a personal query`,
			prompts,
		);
		if (!choice || choice === prompts[1]) {
			await forceRefreshQuota(ctx);
			const errMsg = quotaState?.error ? formatQuotaError(quotaState) : "";
			ctx.ui.notify(
				quotaState?.error ? `GLM quota query failed: ${errMsg}` : "GLM quota enabled (personal query)",
				"info",
			);
			return;
		}

		const organization = await ctx.ui.input("Organization ID", cur?.organization ?? "");
		const project = await ctx.ui.input("Project ID", cur?.project ?? "");
		const org = organization?.trim() ?? "";
		const proj = project?.trim() ?? "";
		if (!org || !proj) {
			ctx.ui.notify("Organization/Project ID cannot be empty, credentials not saved", "warning");
			return;
		}

		tokenConfig = {
			...baseTokenConfig(),
			teamCredential: { organization: org, project: proj },
		};
		await saveTokenConfig(tokenConfig);

		await forceRefreshQuota(ctx);
		const errMsg = quotaState?.error ? formatQuotaError(quotaState) : "";
		ctx.ui.notify(quotaState?.error ? `GLM team quota query failed: ${errMsg}` : "GLM team quota enabled", "info");
	}

	/** Clear all quota caches at session_start to avoid cross-session reuse. */
	async function invalidateAllQuotaCache() {
		try {
			if (existsSync(QUOTA_CACHE_FILE)) {
				await writeFile(QUOTA_CACHE_FILE, "{}", "utf-8");
			}
		} catch {
			/* ignore */
		}
	}

	function weightedCacheHitRate(d: { sumInput: number; sumCacheRead: number; sumCacheWrite: number }): number {
		const total = d.sumInput + d.sumCacheRead + d.sumCacheWrite;
		return total > 0 ? (d.sumCacheRead / total) * 100 : 0;
	}

	function renderDaySummary(daily: DailyRecord): string[] {
		const d = daily;
		const avgInput = d.count > 0 ? d.sumInput / d.count : 0;
		const avgOutput = d.count > 0 ? d.sumOutput / d.count : 0;
		const totalPrompt = d.sumInput + d.sumCacheRead + d.sumCacheWrite;
		const cacheHitRate = weightedCacheHitRate(d);

		return renderTable(
			["Metric", "Value"],
			[
				["Sessions", String(d.count)],
				["New input", `${formatTokens(d.sumInput)} (avg ${formatTokens(avgInput)}/turn, uncached)`],
				["Cached input", formatTokens(d.sumCacheRead)],
				["Total output", `${formatTokens(d.sumOutput)} (avg ${formatTokens(avgOutput)}/turn)`],
				["Total tokens", `${formatTokens(totalPrompt)} (new + cached)`],
				["Cache hit rate", `${cacheHitRate.toFixed(1)}%`],
				["Avg speed", `${(d.sumTokensPerSec / d.count).toFixed(1)} t/s`],
			],
		);
	}

	async function showStats(lines: string[], title: string, _ctx: ExtensionContext) {
		const text = `## ${title}\n\n${lines.join("\n")}`;
		pi.sendMessage({
			customType: "token-stats",
			content: text,
			display: true,
			details: {},
		});
	}

	async function showDay(date: string, ctx: ExtensionContext) {
		let records: DailyRecord[] = [];
		try {
			records = (await readFile(DAILY_FILE, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			// nothing
		}
		const daily = records.find((r) => r.date === date) || null;

		if (!daily) {
			ctx.ui.notify(`No stats for ${date}`, "info");
			return;
		}

		await showStats(
			[...renderDaySummary(daily), ...renderModelBreakdown(await readRawRecordsForDates([date]))],
			`Token stats  |  ${date}`,
			ctx,
		);
	}

	async function showHourly(date: string, ctx: ExtensionContext) {
		const file = join(HOURLY_DIR, `${date}.jsonl`);
		let records: HourlyRecord[] = [];
		try {
			records = (await readFile(file, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			// nothing
		}

		if (records.length === 0) {
			ctx.ui.notify(`No hourly stats for ${date}`, "info");
			return;
		}

		records.sort((a, b) => a.hour - b.hour);

		const lines = renderTable(
			["Time", "Count", "New input", "Cached input", "Output", "Total tokens", "Hit rate", "Speed"],
			records.map((r) => {
				const totalPrompt = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
				return [
					String(r.hour).padStart(2, "0"),
					String(r.count),
					formatTokens(r.sumInput),
					formatTokens(r.sumCacheRead),
					formatTokens(r.sumOutput),
					formatTokens(totalPrompt),
					`${weightedCacheHitRate(r).toFixed(1)}%`,
					`${(r.sumTokensPerSec / r.count).toFixed(1)}`,
				];
			}),
			{
				aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
			},
		);

		await showStats(lines, `By hour  |  ${date}`, ctx);
	}

	async function showWeek(ctx: ExtensionContext) {
		let records: DailyRecord[] = [];
		try {
			records = (await readFile(DAILY_FILE, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			// nothing
		}

		// Include the most recent seven days.
		const today = getDateStr();
		const sevenDaysAgo = getDateStr(Date.now() - 7 * 24 * 60 * 60 * 1000);
		const weekRecords = records
			.filter((r) => r.date >= sevenDaysAgo && r.date <= today)
			.sort((a, b) => a.date.localeCompare(b.date));

		if (weekRecords.length === 0) {
			ctx.ui.notify("No stats for this week", "info");
			return;
		}

		const lines = renderTable(
			["Date", "Count", "New input", "Cached input", "Output", "Total tokens", "Hit rate", "Speed"],
			weekRecords.map((r) => {
				const totalPrompt = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
				return [
					r.date,
					String(r.count),
					formatTokens(r.sumInput),
					formatTokens(r.sumCacheRead),
					formatTokens(r.sumOutput),
					formatTokens(totalPrompt),
					`${weightedCacheHitRate(r).toFixed(1)}%`,
					`${(r.sumTokensPerSec / r.count).toFixed(1)}`,
				];
			}),
			{
				aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
			},
		);

		await showStats(
			[...lines, ...renderModelBreakdown(await readRawRecordsInRange(sevenDaysAgo, today))],
			"Week summary by day",
			ctx,
		);
	}

	function getMonthStr(date: Date = new Date()): string {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		return `${y}-${m}`;
	}

	async function showMonth(month: string, ctx: ExtensionContext) {
		let records: DailyRecord[] = [];
		try {
			records = (await readFile(DAILY_FILE, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			// nothing
		}

		const monthRecords = records.filter((r) => r.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));

		if (monthRecords.length === 0) {
			ctx.ui.notify(`No stats for ${month}`, "info");
			return;
		}

		const total = monthRecords.reduce(
			(acc, r) => {
				acc.count += r.count;
				acc.sumInput += r.sumInput;
				acc.sumCacheRead += r.sumCacheRead;
				acc.sumCacheWrite += r.sumCacheWrite;
				acc.sumOutput += r.sumOutput;
				acc.sumTokensPerSec += r.sumTokensPerSec;
				return acc;
			},
			{ count: 0, sumInput: 0, sumCacheRead: 0, sumCacheWrite: 0, sumOutput: 0, sumTokensPerSec: 0 },
		);
		const totalPrompt = total.sumInput + total.sumCacheRead + total.sumCacheWrite;
		const cacheHitRate = weightedCacheHitRate(total);

		const lines = renderTable(
			["Date", "Count", "New input", "Cached input", "Output", "Total tokens", "Hit rate", "Speed"],
			monthRecords.map((r) => {
				const tp = r.sumInput + r.sumCacheRead + r.sumCacheWrite;
				return [
					r.date,
					String(r.count),
					formatTokens(r.sumInput),
					formatTokens(r.sumCacheRead),
					formatTokens(r.sumOutput),
					formatTokens(tp),
					`${weightedCacheHitRate(r).toFixed(1)}%`,
					`${(r.sumTokensPerSec / r.count).toFixed(1)}`,
				];
			}),
			{
				aligns: ["left", "right", "right", "right", "right", "right", "right", "right"],
				totalRow: [
					"Total",
					String(total.count),
					formatTokens(total.sumInput),
					formatTokens(total.sumCacheRead),
					formatTokens(total.sumOutput),
					formatTokens(totalPrompt),
					`${cacheHitRate.toFixed(1)}%`,
					`${(total.sumTokensPerSec / total.count).toFixed(1)}`,
				],
			},
		);

		const monthDates = monthRecords.map((r) => r.date).sort();
		await showStats(
			[
				...lines,
				...renderModelBreakdown(await readRawRecordsInRange(monthDates[0], monthDates[monthDates.length - 1])),
			],
			`${month} summary`,
			ctx,
		);
	}

	pi.registerMessageRenderer("token-stats", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Markdown(content, 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("dim", text),
		});
	});

	pi.on("agent_start", (_event, _ctx) => {
		resetRunStats();
	});

	pi.on("turn_start", async (_event, ctx) => {
		stats.turnStartTime = Date.now();
		stats.firstTokenTime = 0;
		stats.streaming = false;

		if (ctx.model?.provider !== lastQuotaProvider) {
			lastQuotaProvider = ctx.model?.provider ?? null;
			quotaState = null;
			await refreshQuota(ctx, true);
			shared.requestRender?.();
		}

		shared.requestRender?.();
	});

	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const content = event.message.content;
		if (!Array.isArray(content)) return;

		const streamEvent = (
			event as typeof event & {
				assistantMessageEvent?: {
					type?: string;
					delta: string;
					partial?: { usage?: { output?: number } };
				};
			}
		).assistantMessageEvent;
		if (
			streamEvent?.type !== "text_delta" &&
			streamEvent?.type !== "thinking_delta" &&
			streamEvent?.type !== "toolcall_delta"
		) {
			if (stats.firstTokenTime === 0) stats.firstTokenTime = Date.now();
			stats.streaming = true;
			return;
		}

		if (stats.firstTokenTime === 0) stats.firstTokenTime = Date.now();
		stats.streaming = true;

		const nowMs = Date.now();
		stats.liveOutputChars += streamEvent.delta.length;

		const usageOutputTokens = streamEvent.partial?.usage?.output;
		let newTokens = 0;
		if (typeof usageOutputTokens === "number" && usageOutputTokens > stats.liveUsageOutputTokens) {
			newTokens = usageOutputTokens - stats.liveUsageOutputTokens;
			stats.liveUsageOutputTokens = usageOutputTokens;
			stats.liveEstimatedTokens = usageOutputTokens;
		} else if (stats.liveUsageOutputTokens <= 0) {
			const estimated = estimateTokens(stats.liveOutputChars);
			newTokens = Math.max(0, estimated - stats.liveEstimatedTokens);
			stats.liveEstimatedTokens = estimated;
		}

		if (newTokens > 0) {
			stats.liveTokenSamples.push({ timestampMs: nowMs, tokens: newTokens });
		}

		shared.requestRender?.();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const assistantMsg = event.message as AssistantMessage;
		const usage = assistantMsg.usage;
		if (!usage) return;

		const usageKey =
			assistantMsg.responseId ||
			`${assistantMsg.timestamp}:${assistantMsg.provider}:${assistantMsg.model}:${usage.input}:${usage.output}`;
		if (stats.accountedUsageKeys.has(usageKey)) return;
		stats.accountedUsageKeys.add(usageKey);

		const totalElapsed = stats.turnStartTime > 0 ? (Date.now() - stats.turnStartTime) / 1000 : 0;
		const tokensPerSec = totalElapsed >= 0.05 ? usage.output / totalElapsed : 0;
		const liveSpeed = getRollingLiveTokenSpeed();
		const firstTokenLatency =
			stats.firstTokenTime > 0 && stats.turnStartTime > 0 ? stats.firstTokenTime - stats.turnStartTime : 0;
		const wordCount = countWords(extractTextContent(event.message.content));
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const cacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : 0;
		const cost = usage.cost?.total ?? 0;

		stats.lastInput = usage.input;
		stats.lastOutput = usage.output;
		stats.lastCacheRead = usage.cacheRead;
		stats.lastCacheWrite = usage.cacheWrite;
		stats.lastCost = cost;
		stats.lastCacheHitRate = cacheHitRate;
		stats.lastTokensPerSec = tokensPerSec;
		stats.lastLiveTokenSpeed = liveSpeed;
		stats.lastFirstTokenLatency = firstTokenLatency;
		stats.lastWordCount = wordCount;
		stats.streaming = false;

		stats.totalInput += usage.input;
		stats.totalOutput += usage.output;
		stats.totalCacheRead += usage.cacheRead;
		stats.totalCacheWrite += usage.cacheWrite;
		stats.totalCost += cost;
		stats.totalCacheHitRateSum += cacheHitRate;
		stats.turnCount++;

		runStats.input += usage.input;
		runStats.output += usage.output;
		runStats.cacheRead += usage.cacheRead;
		runStats.cacheWrite += usage.cacheWrite;
		runStats.turns++;
		runLastMsgMs = Date.now();

		shared.requestRender?.();

		const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
		const model = `${event.message.provider}/${event.message.model}`;
		await persistTurn(
			{
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				tokensPerSec,
				cacheHitRate,
				model,
				firstTokenLatency,
				wordCount,
				cost,
				liveTokenSpeed: liveSpeed,
			},
			sessionId,
		);

		resetLiveState();
	});

	pi.on("agent_end", async (_event, _ctx) => {
		stats.streaming = false;
		resetLiveState();
		shared.requestRender?.();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// Clear timers and captured contexts before Pi invalidates the session context.
		shared.sessionActive = false;
		if (quotaTimerId) {
			clearInterval(quotaTimerId);
			quotaTimerId = null;
		}
		shared.requestRender = null;
		lastQuotaProvider = null;
		quotaState = null;
	});

	pi.on("session_start", async (_event, ctx) => {
		shared.sessionActive = true;
		rebuildFromHistory(ctx);

		tokenConfig = await loadTokenConfig();
		displayConfig = await loadDisplayConfig();
		lastQuotaProvider = null;
		quotaState = null;
		await invalidateAllQuotaCache();
		if (quotaTimerId) clearInterval(quotaTimerId);
		// Start with cached quota data and refresh expired entries without blocking session startup.
		void refreshQuota(ctx, false).catch(() => {});
		quotaTimerId = setInterval(
			async () => {
				if (!shared.sessionActive) return;
				try {
					if (ctx.model?.provider !== lastQuotaProvider) {
						await refreshQuota(ctx, true);
					} else {
						await refreshQuota(ctx, false);
					}
				} catch {
					// Ignore callbacks holding a stale session context.
				}
				shared.requestRender?.();
			},
			(tokenConfig?.ttl || 60) * 1000,
		);
	});

	pi.registerCommand("stats", {
		description: "Token stats: day | hour | week | month | config | limit",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (!arg) {
				await showDay(getDateStr(), ctx);
				return;
			}

			if (arg === "limit") {
				const provider = ctx.model?.provider;
				if (!provider) {
					ctx.ui.notify("Cannot get current provider, switch conversation first", "warning");
					return;
				}
				const options = ["Off", ...TOKEN_PLANS.map((plan) => plan.name)];
				const choice = await ctx.ui.select(`Select quota plan to show for ${provider} (select to exit)`, options);

				const defaults: TokenConfig = { providerPlans: {}, ttl: 60 };

				if (!choice || choice === options[0]) {
					tokenConfig = tokenConfig
						? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: null } }
						: { ...defaults, providerPlans: { [provider]: null } };
					await saveTokenConfig(tokenConfig);
					lastQuotaProvider = provider;
					quotaState = null;
					if (quotaTimerId) clearInterval(quotaTimerId);
					quotaTimerId = setInterval(
						async () => {
							if (!shared.sessionActive) return;
							try {
								await refreshQuota(ctx);
							} catch {
								// Ignore callbacks holding a stale session context.
							}
							shared.requestRender?.();
						},
						(tokenConfig?.ttl || 60) * 1000,
					);
					shared.requestRender?.();
					ctx.ui.notify(`Quota display for ${provider} is off`, "info");
					return;
				}
				const plan = TOKEN_PLANS.find((candidate) => candidate.name === choice);
				if (plan) {
					tokenConfig = tokenConfig
						? { ...tokenConfig, providerPlans: { ...tokenConfig.providerPlans, [provider]: plan.id } }
						: { ...defaults, providerPlans: { [provider]: plan.id } };
					await saveTokenConfig(tokenConfig);
					lastQuotaProvider = provider;
					await forceRefreshQuota(ctx);
					if (quotaTimerId) clearInterval(quotaTimerId);
					quotaTimerId = setInterval(
						async () => {
							if (!shared.sessionActive) return;
							try {
								await refreshQuota(ctx);
							} catch {
								// Ignore callbacks holding a stale session context.
							}
							shared.requestRender?.();
						},
						(tokenConfig?.ttl || 60) * 1000,
					);
					if (plan.id === "glm") {
						await promptGlmTeamConfig(ctx);
						return;
					}
					if (quotaState?.error) {
						const errMsg = formatQuotaError(quotaState);
						ctx.ui.notify(`${plan.name} quota query failed: ${errMsg}`, "info");
					} else {
						ctx.ui.notify(`${plan.name} quota enabled`, "info");
					}
				}
				return;
			}

			if (arg === "config") {
				const cfgOpts = [
					"Display style",
					"Display items",
					`Refresh interval (current ${tokenConfig?.ttl || 60}s)`,
					"GLM team credentials",
				];
				const subChoice = await ctx.ui.select("Settings", cfgOpts);
				if (!subChoice) return;

				if (subChoice === cfgOpts[3]) {
					const cur = tokenConfig?.teamCredential;
					const label = cur?.organization && cur?.project ? `${cur.organization} / ${cur.project}` : "not configured";
					const actions = ["✏️ Configure / Edit", "Clear", "Back"];
					const action = await ctx.ui.select(`GLM team credentials (current: ${label})`, actions);
					if (!action || action === actions[2]) return;
					if (action === actions[1]) {
						tokenConfig = {
							...baseTokenConfig(),
							teamCredential: { organization: "", project: "" },
						};
						await saveTokenConfig(tokenConfig);
						await forceRefreshQuota(ctx);
						ctx.ui.notify("GLM team credentials cleared (back to personal query)", "info");
					} else {
						const organization = await ctx.ui.input("Organization ID", cur?.organization ?? "");
						const project = await ctx.ui.input("Project ID", cur?.project ?? "");
						const org = organization?.trim() ?? "";
						const proj = project?.trim() ?? "";
						if (!org || !proj) {
							ctx.ui.notify("Organization/Project ID cannot be empty, not saved", "warning");
							return;
						}
						tokenConfig = {
							...baseTokenConfig(),
							teamCredential: { organization: org, project: proj },
						};
						await saveTokenConfig(tokenConfig);
						await forceRefreshQuota(ctx);
						const errMsg = quotaState?.error ? formatQuotaError(quotaState) : "";
						if (quotaState?.error) {
							ctx.ui.notify(`GLM team quota query failed: ${errMsg}`, "info");
						} else {
							ctx.ui.notify("GLM team credentials saved (team query active)", "info");
						}
					}
					return;
				}

				if (subChoice === cfgOpts[0]) {
					const catOpts = ["Context style", "⚡ Speed style"];
					const catChoice = await ctx.ui.select("Select style category to configure", catOpts);
					if (!catChoice) return;

					if (catChoice === catOpts[0]) {
						const items: { label: string; value: ContextStyle; preview: string }[] = [
							{ label: "pct-window", value: "pct-window", preview: `5.3%/1.0M` },
							{ label: "used-window", value: "used-window", preview: `256k/1.0M` },
							{ label: "pct", value: "pct", preview: `5.3%` },
							{ label: "used", value: "used", preview: `256k` },
							{ label: "bar", value: "bar", preview: `[██░░░░░░] 25%` },
						];
						const choice = await ctx.ui.select(
							`Context style (current: ${displayConfig.contextStyle})`,
							items.map((i) => `${(displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}`),
						);
						if (choice) {
							const idx = items.findIndex(
								(i) => `${(displayConfig.contextStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}` === choice,
							);
							if (idx >= 0) {
								displayConfig = { ...displayConfig, contextStyle: items[idx].value };
								await saveDisplayConfig(displayConfig);
								shared.requestRender?.();
							}
						}
					} else {
						const items: { label: string; value: SpeedStyle; preview: string }[] = [
							{ label: "t/s", value: "t/s", preview: `⚡77.7 t/s` },
							{ label: "tok/s", value: "tok/s", preview: `⚡77.7 tok/s` },
							{ label: "T/s", value: "T/s", preview: `⚡77.7 T/s` },
							{ label: "live@rate", value: "liveAt", preview: `⚡1.2k@77.7` },
						];
						const choice = await ctx.ui.select(
							`⚡ Speed style (current: ${displayConfig.speedStyle})`,
							items.map((i) => `${(displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}`),
						);
						if (choice) {
							const idx = items.findIndex(
								(i) => `${(displayConfig.speedStyle === i.value ? "● " : "○ ") + i.label}  ${i.preview}` === choice,
							);
							if (idx >= 0) {
								displayConfig = { ...displayConfig, speedStyle: items[idx].value };
								await saveDisplayConfig(displayConfig);
								shared.requestRender?.();
							}
						}
					}
					ctx.ui.notify("Display style saved", "info");
				} else if (subChoice === cfgOpts[1]) {
					const itemLabels: DisplayKey[] = [
						"input",
						"output",
						"totalTokens",
						"cost",
						"cacheHit",
						"speed",
						"context",
						"quota5h",
						"quotaDay",
						"quotaWeek",
						"quotaMonth",
						"quotaBalance",
						"quotaClock",
					];
					const itemNames: Record<DisplayKey, string> = {
						input: "Input",
						output: "Output",
						totalTokens: "Total tokens",
						cost: "Cost",
						cacheHit: "Cache hit",
						speed: "Speed",
						context: "Context",
						quota5h: "5h quota",
						quotaDay: "Daily quota",
						quotaWeek: "Weekly quota",
						quotaMonth: "Monthly quota",
						quotaBalance: "Balance",
						quotaClock: "Reset time",
					};
					while (true) {
						const options = itemLabels.map((k) => `${displayConfig.items[k] ? "✅" : "⬜"} ${itemNames[k]}`);
						options.push("🔙 Done");
						const choice = await ctx.ui.select("Select items to toggle", options);
						if (!choice || choice === options[options.length - 1]) break;
						const idx = options.indexOf(choice);
						if (idx >= 0 && idx < itemLabels.length) {
							const key = itemLabels[idx];
							displayConfig = {
								...displayConfig,
								items: { ...displayConfig.items, [key]: !displayConfig.items[key] },
							};
							await saveDisplayConfig(displayConfig);
							shared.requestRender?.();
						}
					}
					ctx.ui.notify("Status bar display config saved", "info");
				} else if (subChoice === cfgOpts[2]) {
					const input = await ctx.ui.input("Refresh interval in seconds", String(tokenConfig?.ttl || 60));
					if (input) {
						const sec = parseInt(input, 10);
						if (Number.isNaN(sec) || sec < 10) {
							ctx.ui.notify("Refresh interval must be >= 10s", "warning");
						} else {
							tokenConfig = tokenConfig ? { ...tokenConfig, ttl: sec } : { providerPlans: {}, ttl: sec };
							await saveTokenConfig(tokenConfig);
							if (quotaTimerId) clearInterval(quotaTimerId);
							quotaTimerId = setInterval(async () => {
								if (!shared.sessionActive) return;
								try {
									await refreshQuota(ctx);
								} catch {
									// Ignore callbacks holding a stale session context.
								}
								shared.requestRender?.();
							}, sec * 1000);
							ctx.ui.notify(`Refresh interval set to ${sec}s`, "info");
						}
					}
				}
				return;
			}

			if (arg === "today" || arg === "day") {
				await showDay(getDateStr(), ctx);
			} else if (arg.startsWith("day ")) {
				const date = arg.slice(4).trim();
				if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
					await showDay(date, ctx);
				} else {
					ctx.ui.notify("Usage: /stats day YYYY-MM-DD", "warning");
				}
			} else if (arg === "hour") {
				await showHourly(getDateStr(), ctx);
			} else if (arg.startsWith("hour ")) {
				const date = arg.slice(5).trim();
				if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
					await showHourly(date, ctx);
				} else {
					ctx.ui.notify("Usage: /stats hour YYYY-MM-DD", "warning");
				}
			} else if (arg === "week") {
				await showWeek(ctx);
			} else if (arg === "month") {
				await showMonth(getMonthStr(), ctx);
			} else if (arg.startsWith("month ")) {
				const ms = arg.slice(6).trim();
				if (/^\d{4}-\d{2}$/.test(ms)) {
					await showMonth(ms, ctx);
				} else {
					ctx.ui.notify("Usage: /stats month YYYY-MM", "warning");
				}
			} else {
				ctx.ui.notify("Usage: /stats [day [date] | hour [date] | week | month [YYYY-MM] | config]", "warning");
			}
		},
	});

	return {
		getMetricParts,
	};
}
