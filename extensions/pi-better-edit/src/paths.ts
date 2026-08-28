import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

export {
	configDir,
	hashStoreDir,
	hashStorePath,
	legacyHashStorePath,
} from "./hash-store.ts";

function homeBase(): string {
	const envHome = process.env.HOME;
	return envHome && envHome.length > 0 ? envHome : homedir();
}

function expand(filePath: string): string {
	const home = homeBase();
	if (filePath === "~") return home;
	if (filePath.startsWith("~/")) return home + filePath.slice(1);
	return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
	const expanded = expand(filePath);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
