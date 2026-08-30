import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
const fail = (message: string): never => {
	throw new Error(message);
};

const manifest = await readJson<Manifest>("package.json");
const rootDeps = new Set([
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.devDependencies ?? {}),
	...Object.keys(manifest.peerDependencies ?? {}),
]);

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
	const extManifest = await readJson<Manifest>(`extensions/${name}/package.json`);
	const allowed = new Set([
		...Object.keys(extManifest.dependencies ?? {}),
		...Object.keys(extManifest.devDependencies ?? {}),
		...Object.keys(extManifest.peerDependencies ?? {}),
		...rootDeps,
	]);
	const sourceFiles = (await readdir(resolve(root, "extensions", name), { recursive: true })).filter((path) =>
		path.endsWith(".ts"),
	);
	for (const path of sourceFiles) {
		const source = await readFile(resolve(root, "extensions", name, path), "utf8");
		for (const specifier of importSpecifiers(source)) {
			if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
			const dep = packageName(specifier);
			if (!dep || !allowed.has(dep)) fail(`Undeclared import in ${name}/${path}: ${specifier}`);
		}
	}
}

console.log("Checks passed.");
