import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ServerConfig {
	name: string;
	command: string[];
	extensions: string[];
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
	skipDirectories: Set<string>;
	diagnosticsGraceMs: number;
}

export interface LspConfig {
	servers: ServerConfig[];
	timeoutMs: number;
}

const FILE_LIMIT = 50;
const SKIP = [
	".git",
	".hg",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".tox",
	".venv",
	"__pycache__",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
	"venv",
];

const DEFAULTS: Array<[string, string[], string[], string[]?]> = [
	[
		"biome",
		["biome", "lsp-proxy"],
		[
			"astro",
			"css",
			"cts",
			"cjs",
			"graphql",
			"gql",
			"html",
			"js",
			"json",
			"jsonc",
			"jsx",
			"mjs",
			"mts",
			"svelte",
			"ts",
			"tsx",
			"vue",
		],
	],
	["ty", ["ty", "server"], ["py", "pyi"]],
	["ruff", ["ruff", "server"], ["py", "pyi"]],
	["rust-analyzer", ["rust-analyzer"], ["rs"]],
	["gopls", ["gopls"], ["go"]],
	["rubocop", ["rubocop", "--lsp"], ["rb", "rake", "gemspec", "ru"]],
	[
		"elixir-ls",
		[process.platform === "win32" ? "language_server.bat" : "language_server.sh"],
		["ex", "exs"],
		["_build", "deps"],
	],
	["zls", ["zls"], ["zig", "zon"], [".zig-cache", "zig-out"]],
	["csharp", ["roslyn-language-server", "--stdio", "--autoLoadProjects"], ["cs", "csx"], ["bin", "obj"]],
	["fsharp", ["fsautocomplete"], ["fs", "fsi", "fsx", "fsscript"], ["bin", "obj"]],
	["sourcekit-lsp", ["sourcekit-lsp"], ["swift", "mm"], [".build", "DerivedData"]],
	[
		"clangd",
		["clangd", "--background-index", "--clang-tidy"],
		["c", "cpp", "cc", "cxx", "c++", "h", "hpp", "hh", "hxx", "h++"],
		["build"],
	],
	["jdtls", ["jdtls"], ["java"], [".gradle", "build"]],
	["kotlin-lsp", ["kotlin-lsp", "--stdio"], ["kt", "kts"], [".gradle", "build"]],
	["yaml-language-server", ["yaml-language-server", "--stdio"], ["yaml", "yml"]],
	["lua-language-server", ["lua-language-server"], ["lua"]],
	["intelephense", ["intelephense", "--stdio"], ["php"]],
	["prisma", ["prisma-language-server", "--stdio"], ["prisma"]],
	["dart", ["dart", "language-server"], ["dart"], [".dart_tool", "build"]],
	["ocaml-lsp", ["ocamllsp"], ["ml", "mli"], ["_build", "_opam"]],
	["bash-language-server", ["bash-language-server", "start"], ["sh", "bash"]],
	["terraform-ls", ["terraform-ls", "serve"], ["tf", "tfvars"], [".terraform"]],
	["texlab", ["texlab"], ["tex", "bib"]],
	["gleam", ["gleam", "lsp"], ["gleam"], ["build"]],
	["clojure-lsp", ["clojure-lsp", "listen"], ["clj", "cljs", "cljc", "edn"], [".cpcache"]],
	["nixd", ["nixd"], ["nix"]],
	["tinymist", ["tinymist"], ["typ", "typc"]],
	[
		"haskell-language-server",
		["haskell-language-server-wrapper", "--lsp"],
		["hs", "lhs"],
		[".stack-work", "dist-newstyle"],
	],
];

export function loadConfig(root: string): LspConfig {
	const source = process.env.PI_LSP_CONFIG?.trim();
	let raw: unknown;
	if (source) {
		raw = source.startsWith("{") ? JSON.parse(source) : readJson(resolveConfigPath(source, root));
	} else {
		const project = path.join(root, CONFIG_DIR_NAME, "pi-lsp.json");
		const user = path.join(getAgentDir(), "pi-lsp.json");
		raw = existsSync(project) ? readJson(project) : existsSync(user) ? readJson(user) : undefined;
	}
	if (raw === undefined) {
		return {
			timeoutMs: 20_000,
			servers: DEFAULTS.map(([name, command, extensions, skip]) =>
				normalizeServer(name, { command, extensions, skipDirectories: skip }, true),
			),
		};
	}
	if (!record(raw)) throw new Error("LSP config must be a JSON object.");
	const wrapper = record(raw.servers) ? raw.servers : raw;
	if (!record(wrapper)) throw new Error("LSP config servers must be an object.");
	const timeout = "servers" in raw ? positiveNumber(raw.timeout, 20_000, "timeout") : 20_000;
	const servers = Object.entries(wrapper)
		.filter(([name]) => name !== "timeout")
		.map(([name, value]) => normalizeServer(name, value, false));
	if (!servers.length) throw new Error("LSP config contains no servers.");
	return { servers, timeoutMs: timeout };
}

export function diagnosticRoutes(config: LspConfig, root: string, paths: string[] | undefined, server?: string) {
	const candidates = selectServers(config.servers, server);
	const routes = candidates
		.filter((item) => server || commandExists(commandFor(item)[0] ?? "", root, item.env))
		.map((item) => ({ server: item, files: collectFiles(item, root, paths) }))
		.filter((route) => route.files.length > 0);
	if (!routes.length) {
		throw new Error(
			server
				? `No supported files found for LSP server '${server}'.`
				: "No supported files found for an available configured LSP server.",
		);
	}
	return routes;
}

export function fixRoute(config: LspConfig, root: string, input: string, selected?: string) {
	const file = workspaceFile(root, input);
	const candidates = selectServers(config.servers, selected).filter((server) => supports(server, file));
	if (!candidates.length) throw new Error(`No configured LSP server supports ${input}.`);
	if (!selected && candidates.length > 1) {
		throw new Error(
			`Multiple LSP servers support ${input}: ${candidates.map((item) => item.name).join(", ")}. Specify server.`,
		);
	}
	return { server: candidates[0]!, file };
}

export function commandFor(server: ServerConfig) {
	const override = process.env[envName(server.name)]?.trim();
	return override ? splitCommand(override) : server.command;
}

export function commandExists(command: string, cwd: string, overrides?: Record<string, string>) {
	return resolveCommand(command, cwd, overrides) !== undefined;
}

export function resolveCommand(command: string, cwd: string, overrides?: Record<string, string>) {
	const pathValue = overrides?.PATH ?? process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	const candidates =
		command.includes("/") || command.includes("\\")
			? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
			: pathValue.split(path.delimiter).map((directory) => path.resolve(cwd, directory || ".", command));
	for (const base of candidates) {
		for (const extension of extensions) {
			const file = `${base}${extension}`;
			try {
				if (!statSync(file).isFile()) continue;
				if (process.platform !== "win32") accessSync(file, constants.X_OK);
				return file;
			} catch {}
		}
	}
	return undefined;
}

export function languageId(file: string) {
	const extension = path.extname(file).slice(1);
	return LANGUAGE_IDS[extension] ?? extension;
}

export function workspaceFile(root: string, input: string) {
	const file = path.resolve(root, input.replace(/^@/u, ""));
	if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`File does not exist: ${file}`);
	if (!inside(realpathSync(root), realpathSync(file))) throw new Error(`File is outside workspace: ${file}`);
	return file;
}

function collectFiles(server: ServerConfig, root: string, requested?: string[]) {
	const files: string[] = [];
	const visited = new Set<string>();
	const realRoot = realpathSync(root);
	for (const input of requested?.length ? requested : [root]) {
		const target = path.resolve(root, input.replace(/^@/u, ""));
		if (!existsSync(target)) throw new Error(`Requested path does not exist: ${target}`);
		if (!inside(realRoot, realpathSync(target))) throw new Error(`Requested path is outside workspace: ${target}`);
		walk(target);
		if (files.length >= FILE_LIMIT) break;
	}
	return files;

	function walk(target: string) {
		if (files.length >= FILE_LIMIT) return;
		const real = realpathSync(target);
		if (!inside(realRoot, real) || visited.has(real)) return;
		const stat = statSync(target);
		if (stat.isFile()) {
			if (supports(server, target)) files.push(target);
			return;
		}
		if (!stat.isDirectory()) return;
		visited.add(real);
		for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (server.skipDirectories.has(entry.name)) continue;
			walk(path.join(target, entry.name));
			if (files.length >= FILE_LIMIT) return;
		}
	}
}

function normalizeServer(name: string, value: unknown, isDefault: boolean): ServerConfig {
	if (!record(value)) throw new Error(`LSP server '${name}' must be an object.`);
	const command = stringArray(value.command, `${name}.command`);
	const extensions = stringArray(value.extensions, `${name}.extensions`).map((item) =>
		item.startsWith(".") ? item : `.${item}`,
	);
	const env = value.env === undefined ? undefined : stringRecord(value.env, `${name}.env`);
	const initialization =
		value.initialization === undefined ? undefined : object(value.initialization, `${name}.initialization`);
	const extraSkip =
		value.skipDirectories === undefined ? [] : stringArray(value.skipDirectories, `${name}.skipDirectories`);
	const grace = positiveNumber(
		value.diagnosticsGraceMs ?? value.pushDiagnosticsGraceMs ?? value.pullDiagnosticsGraceMs,
		isDefault ? 2_000 : 1_500,
		`${name}.diagnosticsGraceMs`,
	);
	return {
		name,
		command,
		extensions,
		env,
		initialization,
		skipDirectories: new Set([...SKIP, ...extraSkip]),
		diagnosticsGraceMs: grace,
	};
}

function selectServers(servers: ServerConfig[], selected?: string) {
	if (!selected) return servers;
	const name = selected.trim();
	const server = servers.find((item) => item.name === name);
	if (!server)
		throw new Error(`Unknown LSP server '${selected}'. Configured: ${servers.map((item) => item.name).join(", ")}.`);
	return [server];
}

function supports(server: ServerConfig, file: string) {
	return server.extensions.includes(path.extname(file));
}

function envName(name: string) {
	return `PI_${name
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase()}_LSP_COMMAND`;
}

function resolveConfigPath(input: string, root: string) {
	const expanded =
		input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
	return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
}

function readJson(file: string) {
	return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function splitCommand(input: string) {
	const parts = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
	return parts.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2"));
}

function inside(parent: string, child: string) {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArray(value: unknown, label: string) {
	if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string" && item.trim()))
		throw new Error(`${label} must be a non-empty string array.`);
	return value as string[];
}

function positiveNumber(value: unknown, fallback: number, label: string) {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
	return value;
}

function stringRecord(value: unknown, label: string) {
	if (!record(value) || !Object.values(value).every((item) => typeof item === "string"))
		throw new Error(`${label} must contain string values.`);
	return value as Record<string, string>;
}

function object(value: unknown, label: string) {
	if (!record(value)) throw new Error(`${label} must be an object.`);
	return value;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LANGUAGE_IDS: Record<string, string> = {
	bash: "shellscript",
	cjs: "javascript",
	cs: "csharp",
	csx: "csharp",
	cts: "typescript",
	ex: "elixir",
	exs: "elixir",
	fs: "fsharp",
	fsi: "fsharp",
	fsscript: "fsharp",
	fsx: "fsharp",
	gql: "graphql",
	h: "c",
	"h++": "cpp",
	hh: "cpp",
	hpp: "cpp",
	hxx: "cpp",
	js: "javascript",
	jsx: "javascriptreact",
	jsonc: "jsonc",
	ksh: "shellscript",
	lhs: "lhaskell",
	mjs: "javascript",
	mts: "typescript",
	py: "python",
	pyi: "python",
	sh: "shellscript",
	tfvars: "terraform-vars",
	ts: "typescript",
	tsx: "typescriptreact",
	typ: "typst",
	typc: "typst-code",
	yml: "yaml",
};
