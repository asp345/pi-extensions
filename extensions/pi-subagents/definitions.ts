import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, DefinitionRegistry, Selection, ThinkingSetting } from "./types.ts";
import { compact, message } from "./util.ts";

const THINKING = new Set<ThinkingSetting>(["off", "minimal", "low", "medium", "high", "xhigh", "max", "parent"]);
const DEFAULT_DIR = fileURLToPath(new URL("./agents", import.meta.url));

export function discoverDefinitions(cwd: string, projectTrusted = true): DefinitionRegistry {
	const definitions = new Map<string, AgentDefinition>();
	const errors: string[] = [];
	const directories: Array<readonly [string, AgentDefinition["source"]]> = [
		[DEFAULT_DIR, "default"],
		[join(getAgentDir(), "agents"), "global"],
	];
	if (projectTrusted) {
		directories.push([join(cwd, ".agents", "agents"), "workspace"]);
		directories.push([join(cwd, CONFIG_DIR_NAME, "agents"), "project"]);
	}
	for (const [dir, source] of directories) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir)
				.filter((name) => name.endsWith(".md"))
				.sort();
		} catch (error) {
			errors.push(`${dir}: ${message(error)}`);
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				const definition = parseDefinition(path, source);
				const previous = findKey(definitions, definition.name);
				if (previous) definitions.delete(previous);
				definitions.set(definition.name, definition);
			} catch (error) {
				errors.push(`${path}: ${message(error)}`);
			}
		}
	}
	return { definitions, errors };
}

export function parseDefinition(path: string, source: AgentDefinition["source"]): AgentDefinition {
	const raw = readFileSync(path, "utf8");
	const { frontmatter: fm } = parseFrontmatter<Record<string, unknown>>(raw);
	const name = basename(path, ".md");
	if (fm.tools === undefined) throw new Error("configuration error: tools is required");
	const tools = list(fm.tools);
	if (!tools.length) throw new Error("configuration error: tools must name at least one tool");
	const description = text(fm.description)?.trim();
	if (!description) throw new Error("configuration error: description is required");
	const thinking = text(fm.thinking) as ThinkingSetting | undefined;
	if (thinking && !THINKING.has(thinking)) {
		throw new Error(`configuration error: invalid thinking level ${thinking}`);
	}
	const maxTurns = integer(fm.max_turns);
	if (maxTurns !== undefined && maxTurns < 1) {
		throw new Error("configuration error: max_turns must be at least 1");
	}
	const memory = text(fm.memory) as AgentDefinition["memory"] | undefined;
	if (memory && !["user", "project", "local"].includes(memory)) {
		throw new Error(`configuration error: invalid memory scope ${memory}`);
	}
	const models = list(fm.models);
	const legacyModels = list(fm.model);
	return {
		name,
		description,
		tools,
		extensions: selection(fm.extensions, true),
		excludeExtensions: list(fm.exclude_extensions),
		skills: selection(fm.skills, true),
		models: models.length ? models : legacyModels,
		thinking,
		maxTurns,
		persistSession: bool(fm.persist_session, false),
		outputTranscript: bool(fm.output_transcript, true),
		sessionDir: text(fm.session_dir),
		promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
		fork: bool(fm.fork, false),
		runInBackground: bool(fm.run_in_background, true),
		memory,
		worktree: fm.worktree === "worktree" || bool(fm.worktree, false),
		enabled: bool(fm.enabled, true),
		path,
		source,
	};
}

export function definitionBody(definition: AgentDefinition): string {
	const raw = readFileSync(definition.path, "utf8");
	return parseFrontmatter<Record<string, unknown>>(raw).body.trim();
}

export function resolveDefinition(registry: DefinitionRegistry, name: string): AgentDefinition | undefined {
	const key = findKey(registry.definitions, name);
	const definition = key ? registry.definitions.get(key) : undefined;
	return definition?.enabled === false ? undefined : definition;
}

export function definitionSummary(registry: DefinitionRegistry): string {
	return [...registry.definitions.values()]
		.filter((definition) => definition.enabled)
		.map((definition) => `- ${definition.name}: ${compact(definition.description, 240)}`)
		.join("\n");
}

export function definitionTemplate(name: string): string {
	return `---
description: Describe ${name} in one line
tools: read, bash, grep, find, ls
extensions: true
exclude_extensions: none
skills: true
models: parent
thinking: parent
max_turns: 24
persist_session: false
output_transcript: true
prompt_mode: append
fork: false
run_in_background: true
worktree: false
enabled: true
---

Write the selected agent's instructions here.
`;
}

export function safeDefinitionName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) && name !== "." && name !== "..";
}

function selection(value: unknown, fallback: Selection): Selection {
	if (value === undefined || value === null) return fallback;
	if (value === true || value === false) return value;
	const items = list(value);
	if (!items.length || items.some((item) => item.toLowerCase() === "none")) return false;
	if (items.some((item) => item === "*" || item.toLowerCase() === "all")) return true;
	return items;
}

function list(value: unknown): string[] {
	if (Array.isArray(value))
		return value
			.map(String)
			.map((item) => item.trim())
			.filter(Boolean);
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "none") return [];
	return trimmed
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return fallback;
}

function findKey<T>(map: Map<string, T>, wanted: string): string | undefined {
	const lower = wanted.toLowerCase();
	return [...map.keys()].find((key) => key.toLowerCase() === lower);
}
