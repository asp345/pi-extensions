const STORE_RE = /\/nix\/store(?:\/[^\s'"`;&|<>()]*)?/g;
const GUIDANCE = "Read $PI_PACKAGE_DIR/docs, examples, or README.md, or use nix eval.";

export function allowedStorePath(path: string, packageDir: string | undefined): boolean {
	if (!packageDir) return false;
	const target = normalizePath(path);
	const root = normalizePath(packageDir);
	if (target === root) return true;
	if (target === `${root}/README` || target === `${root}/README.md`) return true;
	return (
		target === `${root}/docs` ||
		target.startsWith(`${root}/docs/`) ||
		target === `${root}/examples` ||
		target.startsWith(`${root}/examples/`)
	);
}

export function storeBlockReason(command: string, packageDir: string | undefined): string | null {
	const blocked = blockedStorePaths(command, packageDir);
	if (blocked.length === 0) return null;
	return `Blocked: /nix/store search (${blocked[0]}). ${GUIDANCE}`;
}

export function storePathBlockReason(path: string, packageDir: string | undefined): string | null {
	if (!path.includes("/nix/store")) return null;
	if (allowedStorePath(path, packageDir)) return null;
	return `Blocked: /nix/store search (${normalizePath(path)}). ${GUIDANCE}`;
}

function blockedStorePaths(command: string, packageDir: string | undefined): string[] {
	const found = command.match(STORE_RE);
	if (!found) return [];
	const blocked: string[] = [];
	for (const raw of found) {
		const path = normalizePath(raw);
		if (!allowedStorePath(path, packageDir) && !blocked.includes(path)) blocked.push(path);
	}
	return blocked;
}

function normalizePath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.length > 0 ? trimmed : "/nix/store";
}
