import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Severity = "critical" | "high" | "medium";
type RedactionScope = "protectedOnly" | "allOutput";

export interface GuardConfig {
	enabled: boolean;
	protectedPaths: string[];
	allowedPaths: string[];
	readRedaction: {
		enabled: boolean;
		includeShellOutput: boolean;
		scope: RedactionScope;
		maxBytes: number;
	};
	contentScanning: {
		enabled: boolean;
		blockSeverity: Severity;
	};
	gitProtection: {
		enabled: boolean;
		blockCommit: boolean;
		blockPush: boolean;
	};
}

export const CONFIG_PATH = join(getAgentDir(), "sensitive-guard.json");

const DEFAULTS: GuardConfig = {
	enabled: true,
	protectedPaths: [],
	allowedPaths: [".env.example", ".env.sample", ".env.template", "*.pub"],
	readRedaction: {
		enabled: false,
		includeShellOutput: false,
		scope: "protectedOnly",
		maxBytes: 262_144,
	},
	contentScanning: { enabled: true, blockSeverity: "high" },
	gitProtection: { enabled: true, blockCommit: true, blockPush: true },
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
	return options.includes(value as T) ? (value as T) : fallback;
}

function strings(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

export function loadConfig(): GuardConfig {
	let raw: Record<string, unknown> = {};
	try {
		if (existsSync(CONFIG_PATH)) raw = record(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		return structuredClone(DEFAULTS);
	}

	const readRedaction = record(raw.readRedaction);
	const contentScanning = record(raw.contentScanning);
	const gitProtection = record(raw.gitProtection);

	return {
		enabled: bool(raw.enabled, DEFAULTS.enabled),
		protectedPaths: strings(raw.protectedPaths, DEFAULTS.protectedPaths),
		allowedPaths: strings(raw.allowedPaths, DEFAULTS.allowedPaths),
		readRedaction: {
			enabled: bool(readRedaction.enabled, DEFAULTS.readRedaction.enabled),
			includeShellOutput: bool(readRedaction.includeShellOutput, DEFAULTS.readRedaction.includeShellOutput),
			scope: oneOf(readRedaction.scope, ["allOutput", "protectedOnly"], DEFAULTS.readRedaction.scope),
			maxBytes:
				typeof readRedaction.maxBytes === "number" &&
				Number.isInteger(readRedaction.maxBytes) &&
				readRedaction.maxBytes > 0
					? readRedaction.maxBytes
					: DEFAULTS.readRedaction.maxBytes,
		},
		contentScanning: {
			enabled: bool(contentScanning.enabled, DEFAULTS.contentScanning.enabled),
			blockSeverity: oneOf(
				contentScanning.blockSeverity,
				["critical", "high", "medium"],
				DEFAULTS.contentScanning.blockSeverity,
			),
		},
		gitProtection: {
			enabled: bool(gitProtection.enabled, DEFAULTS.gitProtection.enabled),
			blockCommit: bool(gitProtection.blockCommit, DEFAULTS.gitProtection.blockCommit),
			blockPush: bool(gitProtection.blockPush, DEFAULTS.gitProtection.blockPush),
		},
	};
}

export function saveConfig(config: GuardConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	let raw: Record<string, unknown> = {};
	try {
		if (existsSync(CONFIG_PATH)) raw = record(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		// Replace an unreadable configuration with a valid minimal file.
	}
	delete raw.debug;
	delete raw.blockedEvents;
	delete raw.protectedFileEdits;
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...raw, ...config }, null, 2)}\n`, "utf8");
}

const DEFAULT_PROTECTED = [
	/(^|\/)\.env(?:\.[^/]+)?$/i,
	/(^|\/)(?:auth|secrets?|credentials?)(?:\.(?:json|ya?ml|toml|ini|env|txt|cfg|conf))?$/i,
	/(^|\/)\.(?:npmrc|pypirc|netrc|git-credentials)$/i,
	/(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
	/\.(?:pem|key|p12|pfx|jks|keystore)$/i,
	/(^|\/)\.docker\/config\.json$/i,
	/^\/etc\/(?:shadow|sudoers)$/i,
	/^\/etc\/sudoers\.d\//i,
];

function normalize(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/+/g, "/");
}

function globPattern(pattern: string): RegExp {
	const escaped = normalize(pattern)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\0")
		.replaceAll("*", "[^/]*")
		.replaceAll("\0", ".*")
		.replaceAll("?", "[^/]");
	return new RegExp(`(?:^|/)${escaped}$`, "i");
}

function matchesConfigured(path: string, patterns: string[], cwd: string): boolean {
	const absolute = normalize(resolve(cwd, path));
	const local = normalize(relative(cwd, absolute));
	return patterns.some((pattern) => {
		try {
			const re = globPattern(pattern);
			return re.test(absolute) || re.test(local);
		} catch {
			return false;
		}
	});
}

export function isProtectedPath(path: string, cwd: string, config: GuardConfig): boolean {
	if (!path.trim()) return false;
	const absolute = normalize(resolve(cwd, path));
	if (matchesConfigured(path, config.allowedPaths, cwd)) return false;
	return (
		DEFAULT_PROTECTED.some((pattern) => pattern.test(absolute)) || matchesConfigured(path, config.protectedPaths, cwd)
	);
}
