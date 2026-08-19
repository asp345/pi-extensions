import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	pi?: {
		extensions?: string[];
		themes?: string[];
	};
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
const fail = (message: string): never => {
	throw new Error(message);
};

const manifest = await readJson<Manifest>("package.json");
const extensions = manifest.pi?.extensions ?? [];
const themes = manifest.pi?.themes ?? [];
const expectedDirs = [
	"github-copilot-auto",
	"pi-anthropic-oauth",
	"pi-antigravity-auth",
	"pi-background-tasks",
	"pi-compaction-commands",
	"pi-direnv",
	"pi-goal",
	"pi-gpt-search",
	"pi-lsp",
	"pi-openrouter-metadata",
	"pi-sensitive-guard",
	"pi-service-tier",
	"pi-setup-custom-providers",
	"pi-subagents",
	"pi-usage",
	"question",
];
const actualDirs = (await readdir(resolve(root, "extensions"), { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();
if (actualDirs.join("\n") !== expectedDirs.join("\n")) fail("Unexpected extension directories");

for (const name of actualDirs) {
	const dir = resolve(root, "extensions", name);
	const entries = await readdir(dir);
	if (!entries.includes("package.json")) fail(`Missing extension manifest: ${name}`);
	if (!entries.includes("index.ts")) fail(`Missing extension entrypoint: ${name}`);
}

const expectedEntries = expectedDirs.map((name) => `./extensions/${name}/index.ts`).sort();
if ([...extensions].sort().join("\n") !== expectedEntries.join("\n")) fail("Unexpected extension entrypoints");
if (themes.length !== 1 || themes[0] !== "./themes/flatland.json") {
	fail(`Expected only the Flatland theme, found: ${themes.join(", ")}`);
}

for (const entry of extensions) {
	if (!entry.startsWith("./extensions/") || entry.includes("/@")) fail(`Invalid extension path: ${entry}`);
}

for (const entry of [...extensions, ...themes]) {
	const stat = await lstat(resolve(root, entry));
	if (!stat.isFile()) fail(`Resource is not a file: ${entry}`);
}

const themeFiles = await readdir(resolve(root, "themes"));
if (themeFiles.length !== 1 || themeFiles[0] !== "flatland.json") fail("Unexpected theme files");

// Tooling deps (biome, tsc, @types/*) are not all import.meta.resolve-able, so the
// root install state is not probed here. The per-extension loop below enforces the
// real invariant: every imported package is declared in some manifest.
const rootDeps = new Set([
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.devDependencies ?? {}),
	...Object.keys(manifest.peerDependencies ?? {}),
]);

const packageName = (specifier: string): string =>
	specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/", 1)[0];

for (const name of expectedDirs) {
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
		for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
			const specifier = match[2];
			if (!specifier || specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			const dep = packageName(specifier);
			if (!dep || !allowed.has(dep)) fail(`Undeclared import in ${name}/${path}: ${specifier}`);
		}
	}
}

console.log("Checks passed.");
