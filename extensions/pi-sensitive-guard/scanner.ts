import type { GuardConfig, Severity } from "./config.ts";

interface Pattern {
	name: string;
	severity: Severity;
	re: RegExp;
	secretGroup?: number;
}

const PATTERNS: Pattern[] = [
	{
		name: "private key",
		severity: "critical",
		re: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY(?:\s+BLOCK)?-----/i,
	},
	{ name: "AWS access key", severity: "critical", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{
		name: "AWS secret key",
		severity: "critical",
		re: /\baws_(?:secret_access_key|secret)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})/i,
		secretGroup: 1,
	},
	{ name: "OpenAI API key", severity: "high", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
	{ name: "Anthropic API key", severity: "high", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
	{ name: "Google API key", severity: "high", re: /\bAIza[A-Za-z0-9_-]{35}\b/ },
	{ name: "GitHub token", severity: "high", re: /\b(?:gh[oprsu]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
	{ name: "GitLab token", severity: "high", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
	{ name: "Slack token", severity: "high", re: /\bxox[a-z]-[A-Za-z0-9-]{20,}\b/i },
	{ name: "Stripe key", severity: "high", re: /\b[rs]k_(?:test|live|prod)_[A-Za-z0-9]{10,99}\b/ },
	{ name: "SendGrid key", severity: "critical", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
	{ name: "npm token", severity: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
	{ name: "Vault token", severity: "critical", re: /\b(?:hvs\.[A-Za-z0-9_-]{24}|s\.[A-Za-z0-9]{24})\b/ },
	{ name: "Doppler token", severity: "critical", re: /\bdp\.pt\.[A-Za-z0-9]+\b/ },
	{ name: "JWT", severity: "high", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.+/=-]{10,}\b/ },
	{
		name: "credential URL",
		severity: "high",
		re: /\b(?:mongodb|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:/]+:[^\s@/]+@/i,
	},
	{
		name: "secret assignment",
		severity: "medium",
		re: /(?:^|[\s{[,;])['"]?(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token)['"]?\s*[=:]\s*['"]?([A-Za-z0-9][A-Za-z0-9_./+=-]{19,})/i,
		secretGroup: 1,
	},
];

const ORDER: Record<Severity, number> = { medium: 1, high: 2, critical: 3 };
const SENSITIVE_KEY =
	/^(?:api[_-]?key|client[_-]?secret|password|passwd|pwd|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|npm[_-]?token)$/i;
const PLACEHOLDER = "[REDACTED]";

function global(re: RegExp): RegExp {
	return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

const GLOBAL_PATTERNS = PATTERNS.map((pattern) => ({ ...pattern, re: global(pattern.re) }));

export function scanSecrets(content: string, threshold: Severity): string[] {
	if (!content) return [];
	const findings: string[] = [];
	for (const pattern of PATTERNS) {
		if (ORDER[pattern.severity] < ORDER[threshold]) continue;
		if (pattern.re.test(content)) findings.push(pattern.name);
	}
	return findings;
}

function redactStructured(content: string): string {
	return content
		.split(/(\r?\n)/)
		.map((line) => {
			const match = line.match(/^(\s*(?:export\s+)?["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(.*?)(\s*,?\s*)$/);
			if (!match || !SENSITIVE_KEY.test(match[2] ?? "")) return line;
			const raw = (match[4] ?? "").trim();
			if (!raw || raw.includes(PLACEHOLDER)) return line;
			const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : "";
			return `${match[1]}${match[2]}${match[3]}${quote}${PLACEHOLDER}${quote}${match[5]}`;
		})
		.join("");
}

export function redactOutput(content: string, config: GuardConfig["readRedaction"]): string {
	if (Buffer.byteLength(content, "utf8") > config.maxBytes) {
		return `[pi-sensitive-guard: output withheld because it exceeds ${config.maxBytes} bytes]`;
	}

	let redacted = redactStructured(content);
	for (const pattern of GLOBAL_PATTERNS) {
		redacted = redacted.replace(pattern.re, (...args: unknown[]) => {
			const match = String(args[0] ?? "");
			if (pattern.secretGroup) {
				const secret = args[pattern.secretGroup];
				return typeof secret === "string" ? match.replace(secret, PLACEHOLDER) : PLACEHOLDER;
			}
			return PLACEHOLDER;
		});
	}
	return redacted;
}
