import { getDocsPath, getExamplesPath, getPackageDir, getReadmePath } from "@earendil-works/pi-coding-agent";

const STORE_RE = /\/nix\/store(?:\/[^\s'"`;&|<>()]*)?/g;

function guidance(): string {
	return `Read ${getDocsPath()}, ${getExamplesPath()}, or ${getReadmePath()}, or use nix eval.`;
}

export function allowedStorePath(path: string): boolean {
	const target = normalizePath(path);
	if (target === normalizePath(getPackageDir()) || target === getReadmePath()) return true;
	return [getDocsPath(), getExamplesPath()].some((dir) => target === dir || target.startsWith(`${dir}/`));
}

export function storeBlockReason(command: string): string | null {
	const blocked = command.match(STORE_RE)?.find((raw) => !allowedStorePath(raw));
	if (blocked === undefined) return null;
	return `Blocked: /nix/store search (${normalizePath(blocked)}). ${guidance()}`;
}

export function storePathBlockReason(path: string): string | null {
	if (!path.includes("/nix/store")) return null;
	if (allowedStorePath(path)) return null;
	return `Blocked: /nix/store search (${normalizePath(path)}). ${guidance()}`;
}

function normalizePath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.length > 0 ? trimmed : "/nix/store";
}
