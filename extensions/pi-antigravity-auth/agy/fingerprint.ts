/**
 * Antigravity CLI HTTP identity.
 * User-Agent shape captured from agy CLI 1.1.20:
 * antigravity/cli/1.1.20 (aidev_client; os_type=linux; arch=amd64; cl=970154694; auth_method=consumer)
 */
const AGY_CLI_VERSION = "1.1.20";
const AGY_CLI_CHANGE_LIST = "970154694";

function normalizePlatform(platform: NodeJS.Platform): string {
	return platform === "win32" ? "windows" : platform || "unknown";
}

function normalizeArch(arch: string): string {
	if (arch === "x64") return "amd64";
	if (arch === "ia32") return "386";
	return arch || "unknown";
}

export function buildAntigravityHarnessUserAgent(
	version: string = AGY_CLI_VERSION,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	return `antigravity/cli/${version} (aidev_client; os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)}; cl=${AGY_CLI_CHANGE_LIST}; auth_method=consumer)`;
}
