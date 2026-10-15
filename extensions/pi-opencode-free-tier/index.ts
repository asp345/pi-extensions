import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USER_AGENT = "opencode/2.0.26";
const REQUIRED_TOOL_NAME = "read";
const SCHEMA_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read", "shell", "write"];
const SESSION_HEADER_NAMES = ["x-opencode-session-id", "x-opencode-session", "x-session-affinity", "x-session-id"];
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const COUNTER_LIMIT = 63;

interface TargetModel {
	provider: string;
	baseUrl: string;
	api: string;
}

function isZenFreeLane(model: TargetModel | undefined): boolean {
	if (!model) return false;
	if (model.provider === "opencode") return true;
	try {
		const url = new URL(model.baseUrl);
		return url.hostname === "opencode.ai" && !url.pathname.startsWith("/zen/go");
	} catch {
		return false;
	}
}

function canonicalSessionId(sessionId: string, createdAt: number | undefined): string {
	const digest = createHash("sha256").update(sessionId).digest();
	const timestamp = createdAt ?? Number(BigInt(`0x${digest.subarray(0, 6).toString("hex")}`) >> 7n);
	const counter = 1 + (digest[5] % COUNTER_LIMIT);
	const value = ~(BigInt(timestamp) * 0x1000n + BigInt(counter));
	let id = "";
	for (let index = 0; index < 6; index += 1)
		id += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0");
	for (let index = 6; index < 20; index += 1) id += BASE62[digest[index] % BASE62.length];
	return `ses_${id}`;
}

function setHeader(headers: Record<string, string | null>, name: string, value: string): void {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) delete headers[key];
	}
	headers[name] = value;
}

interface ToolParameters {
	properties?: unknown;
}

interface ToolEntry {
	name?: unknown;
	parameters?: ToolParameters;
	function?: { name?: unknown; parameters?: ToolParameters };
}

function toolName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const entry = tool as ToolEntry;
	if (typeof entry.function?.name === "string") return entry.function.name;
	return typeof entry.name === "string" ? entry.name : undefined;
}

function withPlaceholderProperty(tool: unknown): void {
	const name = toolName(tool);
	if (name === undefined || !SCHEMA_TOOL_NAMES.includes(name)) return;
	const entry = tool as ToolEntry;
	const parameters = entry.function?.parameters ?? entry.parameters;
	if (!parameters || typeof parameters !== "object") return;
	const properties = parameters.properties;
	if (properties && typeof properties === "object" && Object.keys(properties).length > 0) return;
	parameters.properties = { value: { type: "string" } };
}

function stubTool(api: string): Record<string, unknown> {
	const description = `${REQUIRED_TOOL_NAME} is not available for this request. Do not call it.`;
	const parameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
	if (api === "openai-completions")
		return { type: "function", function: { name: REQUIRED_TOOL_NAME, description, parameters } };
	return { type: "function", name: REQUIRED_TOOL_NAME, description, parameters };
}

function ensureClientShape(payload: unknown, api: string): unknown {
	if (api !== "openai-completions" && api !== "openai-responses") return payload;
	if (!payload || typeof payload !== "object") return payload;
	const body = payload as { tools?: unknown; tool_choice?: unknown; stream?: unknown };
	const tools = Array.isArray(body.tools) ? [...body.tools] : [];
	const names = new Set<string>();
	for (const tool of tools) {
		const name = toolName(tool);
		if (name !== undefined) names.add(name);
		withPlaceholderProperty(tool);
	}
	if (!names.has(REQUIRED_TOOL_NAME)) tools.push(stubTool(api));
	body.tools = tools;
	body.stream = true;
	if (api === "openai-completions" && names.size === 0) body.tool_choice = "none";
	return payload;
}

export default function opencodeFreeTierExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isZenFreeLane(ctx.model)) return;
		const header = ctx.sessionManager.getHeader();
		const sessionId = canonicalSessionId(
			ctx.sessionManager.getSessionId(),
			header ? Date.parse(header.timestamp) : undefined,
		);
		setHeader(event.headers, "User-Agent", USER_AGENT);
		for (const name of SESSION_HEADER_NAMES) setHeader(event.headers, name, sessionId);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || !isZenFreeLane(model)) return;
		return ensureClientShape(event.payload, model.api);
	});
}
