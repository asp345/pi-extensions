import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
	name?: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
const problems: string[] = [];

const packageName = (specifier: string): string =>
	specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/", 1)[0];

function importSpecifiers(source: string): string[] {
	const patterns = [
		/^\s*import\s+[^;]*?\bfrom\s*(["'])([^"']+)\1/gm,
		/^\s*export\s+(?:type\s+)?(?:\*|\{)[^;]*?\bfrom\s*(["'])([^"']+)\1/gm,
		/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
	];
	return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[2]).filter(Boolean));
}

const extensionDirs = (await readdir(resolve(root, "extensions"), { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

for (const name of extensionDirs) {
	const manifest = await readJson<Manifest>(`extensions/${name}/package.json`);
	const allowed = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
		...(manifest.name ? [manifest.name] : []),
	]);
	const packageDir = resolve(root, "extensions", name);
	const sourceFiles = (await readdir(packageDir, { recursive: true })).filter((path) => path.endsWith(".ts"));
	for (const path of sourceFiles) {
		const source = await readFile(resolve(packageDir, path), "utf8");
		for (const specifier of importSpecifiers(source)) {
			if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
			if (specifier.startsWith(".")) {
				if (!resolve(packageDir, dirname(path), specifier).startsWith(packageDir + sep)) {
					problems.push(`Import outside ${name} in ${name}/${path}: ${specifier}`);
				}
				continue;
			}
			if (!allowed.has(packageName(specifier))) problems.push(`Undeclared import in ${name}/${path}: ${specifier}`);
		}
	}
}

if (problems.length) throw new Error(problems.join("\n"));
console.log("Checks passed.");
