import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
	dependencies?: Record<string, string>;
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
	"herdr-handoff",
	"openrouter-metadata",
	"pi-anthropic-oauth",
	"pi-antigravity-auth",
	"pi-background-tasks",
	"pi-direnv",
	"pi-goal",
	"pi-herdr-subagents",
	"pi-lsp",
	"pi-sensitive-guard",
	"pi-web-access",
	"question",
];
const actualDirs = (await readdir(resolve(root, "extensions"), { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();
if (actualDirs.join("\n") !== expectedDirs.join("\n")) fail("Unexpected extension directories");
for (const name of actualDirs) {
	if ((await readdir(resolve(root, "extensions", name))).includes("package.json")) fail(`Nested manifest: ${name}`);
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

const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
for (const dependency of dependencies) {
	try {
		import.meta.resolve(dependency);
	} catch {
		fail(`Runtime dependency is not installed: ${dependency}`);
	}
}

const sourceFiles = (await readdir(resolve(root, "extensions"), { recursive: true })).filter((path) =>
	path.endsWith(".ts"),
);
for (const path of sourceFiles) {
	const source = await readFile(resolve(root, "extensions", path), "utf8");
	for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
		const specifier = match[2];
		if (
			!specifier ||
			specifier.startsWith(".") ||
			specifier.startsWith("node:") ||
			specifier.startsWith("@earendil-works/pi-")
		)
			continue;
		const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/", 1)[0];
		if (!name || !dependencies.has(name)) fail(`Undeclared import in ${path}: ${specifier}`);
	}
}

console.log("Checks passed.");
