import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USER_AGENT = "opencode/2.0.26";
const REQUIRED_TOOL_NAMES = ["bash", "read"];
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

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

function canonicalSessionId(sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest();
	let id = digest.subarray(0, 6).toString("hex");
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

function stubTool(name: string, api: string): Record<string, unknown> {
	const description = `${name} is not available for this request. Do not call it.`;
	const parameters = { type: "object", properties: {} };
	if (api === "openai-completions") return { type: "function", function: { name, description, parameters } };
	return { type: "function", name, description, parameters };
}

function ensureRequiredTools(payload: unknown, api: string): unknown {
	if (api !== "openai-completions" && api !== "openai-responses") return payload;
	if (!payload || typeof payload !== "object") return payload;
	const body = payload as { tools?: unknown; tool_choice?: unknown };
	const tools = Array.isArray(body.tools) ? [...body.tools] : [];
	const names = new Set<string>();
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const entry = tool as { name?: unknown; function?: { name?: unknown } };
		const name = typeof entry.function?.name === "string" ? entry.function.name : entry.name;
		if (typeof name === "string") names.add(name);
	}
	const missing = REQUIRED_TOOL_NAMES.filter((name) => !names.has(name));
	if (missing.length === 0) return payload;
	for (const name of missing) tools.push(stubTool(name, api));
	body.tools = tools;
	if (api === "openai-completions" && names.size === 0) body.tool_choice = "none";
	return payload;
}

export default function opencodeFreeTierExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isZenFreeLane(ctx.model)) return;
		setHeader(event.headers, "User-Agent", USER_AGENT);
		setHeader(event.headers, "x-opencode-session", canonicalSessionId(ctx.sessionManager.getSessionId()));
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || !isZenFreeLane(model)) return;
		return ensureRequiredTools(event.payload, model.api);
	});
}
