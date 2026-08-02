import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyEdits, type Diagnostic, LspClient, type TextEdit, type WorkspaceEdit } from "./protocol.js";
import { diagnosticRoutes, fixRoute, inside, languageId, loadConfig, type ServerConfig } from "./routing.js";

const STATUS = "lsp";
const MAX_OUTPUT_BYTES = 30_000;
const MAX_OUTPUT_LINES = 500;

export default function lspExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: "Run bounded diagnostics through configurable language-agnostic LSP routes.",
		promptSnippet: "Get diagnostics from configured LSP servers",
		promptGuidelines: [
			"Use lsp_diagnostics for language-server diagnostics; paths default to the current workspace.",
			"Specify server only to choose a configured route explicitly.",
		],
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to check." })),
			server: Type.Optional(Type.String({ description: "Configured LSP server name." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const root = workspaceRoot(ctx.cwd);
			const config = loadConfig(root, ctx.isProjectTrusted());
			const routes = diagnosticRoutes(config, root, params.paths, params.server);
			const sections: string[] = [];
			const details: Array<{ server: string; files: number; diagnostics: number }> = [];
			try {
				for (const route of routes) {
					ctx.ui.setStatus(STATUS, `${route.server.name} diagnostics`);
					const entries = await runDiagnostics(route.server, route.files, root, config.timeoutMs, signal);
					const count = entries.reduce((total, entry) => total + entry.diagnostics.length, 0);
					details.push({ server: route.server.name, files: entries.length, diagnostics: count });
					sections.push(formatDiagnostics(route.server.name, entries, count));
				}
				return result(bound(sections.join("\n\n---\n\n")), { root, routes: details });
			} finally {
				ctx.ui.setStatus(STATUS, undefined);
			}
		},
	});

	pi.registerTool({
		name: "lsp_fix",
		label: "LSP Fix",
		description: "Compute or apply a configured LSP code action and its workspace edits.",
		promptSnippet: "Compute or apply an LSP code action",
		promptGuidelines: [
			"Use lsp_fix only for files handled by a configured code-action server.",
			"Set apply true only when the requested action should write its workspace edits.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File to process." }),
			action: Type.Optional(Type.String({ description: "Code-action kind; defaults to source.fixAll." })),
			apply: Type.Optional(Type.Boolean({ description: "Apply edits; defaults to false." })),
			server: Type.Optional(Type.String({ description: "Configured LSP server name." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const root = workspaceRoot(ctx.cwd);
			const config = loadConfig(root, ctx.isProjectTrusted());
			const route = fixRoute(config, root, params.path, params.server);
			const action = params.action?.trim() || "source.fixAll";
			ctx.ui.setStatus(STATUS, `${route.server.name} ${action}`);
			try {
				const computed = await runAction(route.server, route.file, root, action, config.timeoutMs, signal);
				const changed = computed.files.filter((file) => file.changed);
				if (params.apply) await queueWrites(changed);
				const summary = [
					`${route.server.name} LSP action ${action}: ${changed.length} file(s) changed${params.apply ? " and applied" : " (preview only)"}.`,
					...changed.map((file) => `- ${path.relative(root, file.path) || file.path}`),
					...(!params.apply ? changed.map((file) => `\n### ${path.relative(root, file.path)}\n${file.next}`) : []),
				].join("\n");
				return result(bound(summary), {
					root,
					server: route.server.name,
					action,
					apply: params.apply ?? false,
					actions: computed.actions.slice(0, 100).map(({ title, kind }) => ({ title, kind })),
					files: computed.files.map((file) => ({
						path: path.relative(root, file.path),
						changed: file.changed,
						edits: file.edits.length,
					})),
				});
			} finally {
				ctx.ui.setStatus(STATUS, undefined);
			}
		},
	});

	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS, undefined));
}

async function runDiagnostics(
	server: ServerConfig,
	files: string[],
	root: string,
	timeout: number,
	signal?: AbortSignal,
) {
	return withClient(server, root, timeout, signal, async (client) => {
		const opened: Array<{ file: string; uri: string }> = [];
		try {
			for (const file of files) {
				if (signal?.aborted) throw new Error(`${server.name} LSP request aborted.`);
				const { uri } = openFile(client, file);
				opened.push({ file, uri });
			}
			return await Promise.all(
				opened.map(async ({ file, uri }) => ({
					path: path.relative(root, file) || file,
					diagnostics: await client.diagnostics(uri),
				})),
			);
		} finally {
			for (const { uri } of opened) client.closeDocument(uri);
		}
	});
}

async function runAction(
	server: ServerConfig,
	file: string,
	root: string,
	kind: string,
	timeout: number,
	signal?: AbortSignal,
) {
	return withClient(server, root, timeout, signal, async (client) => {
		const { uri, text } = openFile(client, file);
		try {
			const diagnostics = await client.diagnostics(uri);
			const allActions = await client.actions(uri, text, diagnostics, kind);
			const actions = allActions.filter((action) => action.kind === kind || action.kind?.startsWith(`${kind}.`));
			const workspace = mergeWorkspaceEdits(
				actions.map((action) => action.edit).filter((edit): edit is WorkspaceEdit => edit !== undefined),
			);
			if (workspace.size > 100) throw new Error(`LSP action attempted to edit ${workspace.size} files; limit is 100.`);
			const files = [...workspace.entries()].map(([editUri, edits]) => {
				if (!editUri.startsWith("file:")) throw new Error(`LSP workspace edit uses a non-file URI: ${editUri}`);
				const editPath = fileURLToPath(editUri);
				assertWorkspaceFile(root, editPath);
				const current = readFileSync(editPath, "utf8");
				const next = applyEdits(current, edits);
				return { path: editPath, current, next, edits, changed: current !== next };
			});
			return { actions, files };
		} finally {
			client.closeDocument(uri);
		}
	});
}

async function withClient<T>(
	server: ServerConfig,
	root: string,
	timeout: number,
	signal: AbortSignal | undefined,
	fn: (client: LspClient) => Promise<T>,
): Promise<T> {
	const client = new LspClient(server, root, timeout);
	await client.start(signal);
	try {
		return await fn(client);
	} finally {
		await client.shutdown();
	}
}

function openFile(client: LspClient, file: string) {
	const uri = pathToFileURL(file).href;
	const text = readFileSync(file, "utf8");
	client.open(uri, text, languageId(file));
	return { uri, text };
}

function mergeWorkspaceEdits(edits: WorkspaceEdit[]) {
	const result = new Map<string, TextEdit[]>();
	for (const edit of edits) {
		for (const [uri, changes] of Object.entries(edit.changes ?? {})) add(uri, changes);
		for (const change of edit.documentChanges ?? []) {
			if (!change.textDocument?.uri || !Array.isArray(change.edits))
				throw new Error("LSP returned an unsupported workspace resource operation.");
			add(change.textDocument.uri, change.edits);
		}
	}
	return result;

	function add(uri: string, changes: TextEdit[]) {
		result.set(uri, [...(result.get(uri) ?? []), ...changes]);
	}
}

async function queueWrites(files: Array<{ path: string; current: string; next: string }>): Promise<void> {
	for (const file of files) {
		await withFileMutationQueue(file.path, async () => {
			const current = readFileSync(file.path, "utf8");
			if (current !== file.current)
				throw new Error(`Refusing stale LSP edit; file changed during the request: ${file.path}`);
			writeFileSync(file.path, file.next, "utf8");
		});
	}
}

function formatDiagnostics(server: string, entries: Array<{ path: string; diagnostics: Diagnostic[] }>, count: number) {
	const lines = [`${server}: ${count} diagnostic(s) across ${entries.length} file(s).`];
	for (const entry of entries) {
		if (!entry.diagnostics.length) {
			lines.push(`${entry.path}: no diagnostics`);
			continue;
		}
		for (const diagnostic of entry.diagnostics) {
			const severity = ["diagnostic", "error", "warning", "info", "hint"][diagnostic.severity ?? 0] ?? "diagnostic";
			const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
			lines.push(
				`${entry.path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${severity} ${diagnostic.source ?? server}${code}: ${diagnostic.message}`,
			);
		}
	}
	return lines.join("\n");
}

function workspaceRoot(cwd: string) {
	const root = path.resolve(cwd);
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
	return root;
}

function assertWorkspaceFile(root: string, file: string) {
	if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Workspace edit target does not exist: ${file}`);
	if (!inside(realpathSync(root), realpathSync(file)))
		throw new Error(`Workspace edit targets a file outside the workspace: ${file}`);
}

function bound(text: string) {
	const lines = text.split("\n");
	let output = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
	let truncated = lines.length > MAX_OUTPUT_LINES;
	if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
		output = Buffer.from(output).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
		truncated = true;
	}
	return truncated
		? `${output}\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES} bytes.]`
		: output;
}

function result(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}
