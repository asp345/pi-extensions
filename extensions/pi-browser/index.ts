import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Browser, type NetworkEntry, PROFILE_DIR, type Tab } from "./browser.ts";

const USAGE_PATH = fileURLToPath(new URL("./USAGE.md", import.meta.url));

const ACTIONS = [
	"tabs",
	"open",
	"close",
	"navigate",
	"snapshot",
	"html",
	"eval",
	"click",
	"type",
	"key",
	"screenshot",
	"console",
	"network",
	"cookies",
	"set_cookie",
	"delete_cookie",
	"cdp",
] as const;

const TEXT_MIME = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg)|\+(json|xml)$/;

type Result = AgentToolResult<undefined>;

function required<T>(value: T | undefined, name: string, action: string): T {
	if (value === undefined || value === "") throw new Error(`${name} is required for action=${action}`);
	return value;
}

function jsonObject(text: string, name: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be a JSON object`);
	return value as Record<string, unknown>;
}

function stringify(value: unknown): string {
	if (value === undefined) return "undefined";
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function headers(values: Record<string, string> | undefined): string {
	return Object.entries(values ?? {})
		.map(([name, value]) => `  ${name}: ${value}`)
		.join("\n");
}

function requestLine(entry: NetworkEntry): string {
	const status = entry.error ? `ERR ${entry.error}` : (entry.status ?? "pending");
	return `${entry.id}  ${entry.method} ${status}  ${entry.type ?? "-"}  ${entry.url}`;
}

async function output(text: string): Promise<Result> {
	const truncation = truncateHead(text);
	if (!truncation.truncated) return { content: [{ type: "text", text: text || "(empty)" }], details: undefined };
	const file = join(await mkdtemp(join(tmpdir(), "pi-browser-")), "output.txt");
	await writeFile(file, text, "utf8");
	const note = `[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}. Full output: ${file}]`;
	return { content: [{ type: "text", text: `${truncation.content}\n\n${note}` }], details: undefined };
}

async function pageLine(browser: Browser, tab: Tab): Promise<string> {
	const page = await browser.info(tab);
	return `${page.targetId.slice(0, 8)}  ${page.title}  ${page.url}`;
}

async function tabsText(browser: Browser): Promise<string> {
	const pages = await browser.pages();
	return pages
		.map(
			(page) =>
				`${browser.isCurrent(page.targetId) ? "*" : " "} ${page.targetId.slice(0, 8)}  ${page.title}  ${page.url}`,
		)
		.join("\n");
}

async function statusText(browser: Browser): Promise<string> {
	const mode = (await browser.headless()) ? "headless" : "headed";
	return `Helium ${mode}, profile ${PROFILE_DIR}\n${await tabsText(browser)}`;
}

async function responseBody(browser: Browser, tab: Tab, entry: NetworkEntry): Promise<string> {
	if (entry.status === undefined) return "(no response)";
	const { body, base64Encoded } = await browser
		.send<{ body: string; base64Encoded: boolean }>(tab, "Network.getResponseBody", { requestId: entry.id })
		.catch((error: Error) => ({ body: `(unavailable: ${error.message})`, base64Encoded: false }));
	if (!base64Encoded) return body;
	const bytes = Buffer.from(body, "base64");
	return TEXT_MIME.test(entry.mimeType ?? "")
		? bytes.toString("utf8")
		: `(binary ${entry.mimeType}, ${bytes.length} bytes)`;
}

async function requestDetails(browser: Browser, tab: Tab, entry: NetworkEntry): Promise<string> {
	return [
		`${entry.method} ${entry.url}`,
		`status: ${entry.error ? `failed (${entry.error})` : `${entry.status ?? "pending"} ${entry.statusText ?? ""}`.trim()}`,
		`type: ${entry.type ?? "-"}  mime: ${entry.mimeType ?? "-"}  size: ${entry.size ?? "-"}`,
		`request headers:\n${headers(entry.requestHeaders)}`,
		entry.postData === undefined ? "" : `request body:\n${entry.postData}`,
		`response headers:\n${headers(entry.responseHeaders)}`,
		`response body:\n${await responseBody(browser, tab, entry)}`,
	]
		.filter(Boolean)
		.join("\n");
}

async function pageUrl(browser: Browser, tab: Tab): Promise<string> {
	return (await browser.info(tab)).url;
}

export default function browserExtension(pi: ExtensionAPI): void {
	const browser = new Browser();

	pi.on("session_shutdown", () => browser.close());

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: `Control a Helium browser over CDP. Read ${USAGE_PATH} before first use.`,
		promptSnippet: "Control a Helium browser over CDP",
		parameters: Type.Object({
			action: StringEnum(ACTIONS),
			tab: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			code: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			id: Type.Optional(Type.String()),
			clear: Type.Optional(Type.Boolean()),
			cookie: Type.Optional(Type.String({ description: "JSON object" })),
			method: Type.Optional(Type.String()),
			params: Type.Optional(Type.String({ description: "JSON object" })),
		}),
		executionMode: "sequential",
		async execute(_id, params): Promise<Result> {
			const { action } = params;
			if (action === "tabs") return output(await tabsText(browser));
			if (action === "open") return output(await pageLine(browser, await browser.open(params.url)));

			const tab = await browser.tab(params.tab);
			switch (action) {
				case "close":
					await browser.closeTab(tab);
					return output(`Closed ${tab.targetId.slice(0, 8)}`);
				case "navigate":
					await browser.navigate(tab, required(params.url, "url", action));
					return output(await pageLine(browser, tab));
				case "snapshot":
					return output(await browser.snapshot(tab));
				case "html": {
					const selector = params.selector;
					const expression = selector
						? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? null`
						: "document.documentElement.outerHTML";
					const html = await browser.evaluate(tab, expression);
					if (html === null) throw new Error(`No element matches ${selector}`);
					return output(String(html));
				}
				case "eval":
					return output(stringify(await browser.evaluate(tab, required(params.code, "code", action))));
				case "click": {
					if (params.selector) {
						const target = await browser.locate(tab, params.selector);
						await browser.click(tab, target);
						return output(`Clicked ${target.label}`);
					}
					const point = { x: required(params.x, "x", action), y: required(params.y, "y", action) };
					await browser.click(tab, point);
					return output(`Clicked (${point.x}, ${point.y})`);
				}
				case "type": {
					const text = required(params.text, "text", action);
					await browser.send(tab, "Input.insertText", { text });
					return output(`Typed ${text.length} characters`);
				}
				case "key": {
					const key = required(params.text, "text", action);
					await browser.key(tab, key);
					return output(`Pressed ${key}`);
				}
				case "screenshot": {
					const { data } = await browser.send<{ data: string }>(tab, "Page.captureScreenshot", { format: "png" });
					const ratio = await browser.evaluate(tab, "window.devicePixelRatio");
					return {
						content: [
							{ type: "image", data, mimeType: "image/png" },
							{ type: "text", text: `devicePixelRatio ${ratio}: CSS px = image px / ${ratio}` },
						],
						details: undefined,
					};
				}
				case "console": {
					const text = tab.console
						.map((entry) => `[${entry.level}] ${entry.text}${entry.source ? `  (${entry.source})` : ""}`)
						.join("\n");
					if (params.clear) tab.console.length = 0;
					return output(text);
				}
				case "network": {
					if (params.id) {
						const entry = tab.network.get(params.id);
						if (!entry) throw new Error(`No request ${params.id} in this tab`);
						return output(await requestDetails(browser, tab, entry));
					}
					const text = [...tab.network.values()].map(requestLine).join("\n");
					if (params.clear) tab.network.clear();
					return output(text);
				}
				case "cookies":
					return output(await browser.cookies(tab, params.url));
				case "set_cookie": {
					const cookie = jsonObject(required(params.cookie, "cookie", action), "cookie");
					const scope = cookie.url || cookie.domain ? {} : { url: await pageUrl(browser, tab) };
					await browser.send(tab, "Network.setCookie", { ...scope, ...cookie });
					return output(`Set cookie ${String(cookie.name)}`);
				}
				case "delete_cookie": {
					const cookie = jsonObject(required(params.cookie, "cookie", action), "cookie");
					const scope = cookie.url || cookie.domain ? {} : { url: await pageUrl(browser, tab) };
					await browser.send(tab, "Network.deleteCookies", { ...scope, ...cookie });
					return output(`Deleted cookie ${String(cookie.name)}`);
				}
				case "cdp":
					return output(
						stringify(
							await browser.send(
								tab,
								required(params.method, "method", action),
								params.params ? jsonObject(params.params, "params") : {},
							),
						),
					);
			}
		},
	});

	pi.registerCommand("browser", {
		description: "Show, launch, or quit the Helium browser used by the browser tool",
		handler: async (args, ctx) => {
			const [command = "status", mode = "headless"] = args.trim().split(/\s+/).filter(Boolean);
			if (command === "status") {
				if (!browser.connected) return ctx.ui.notify(`Not connected. Profile: ${PROFILE_DIR}`, "info");
				return ctx.ui.notify(await statusText(browser), "info");
			}
			if (command === "launch" && (mode === "headless" || mode === "headed")) {
				await browser.launch(mode === "headed");
				return ctx.ui.notify(await statusText(browser), "info");
			}
			if (command === "quit") {
				return ctx.ui.notify((await browser.quit()) ? "Helium closed." : "Helium is not running.", "info");
			}
			ctx.ui.notify("Usage: /browser [status|launch [headless|headed]|quit]", "warning");
		},
	});
}
