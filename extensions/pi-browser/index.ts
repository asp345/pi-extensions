import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Browser, DEFAULT_TIMEOUT_MS, DOWNLOAD_DIR, type NetworkEntry, PROFILE_DIR, type Tab } from "./browser.ts";

const DESCRIPTION = [
	"Control a Helium browser window (dedicated profile) over CDP. The first call launches it. Other Pi sessions may share the browser. When the user must act in the browser (login, CAPTCHA), ask them to do it in the Helium window.",
	`Tabs: tabs; open(url?); close; navigate(url); download(url): saves the response of url in ${DOWNLOAD_DIR} with the browser session, waits until the file is complete, and returns its path. If the response is a CAPTCHA or bot check, it notifies the user and waits for them to pass it; use a timeout of 120 or more for such sites.`,
	"Read: snapshot: accessibility tree, prefer for page structure; html(selector?); eval(code): JS expression, promises awaited; screenshot; console(clear?); network(id?, clear?): list, or headers and bodies of one request; cookies(url?).",
	"Input: click(selector | x,y in CSS px); type(text) at focus; key(text): Enter, Tab, Escape, Backspace, Delete, Arrow*, PageUp, PageDown, Home, End.",
	"Other: set_cookie(cookie); delete_cookie(cookie); cdp(method, params?).",
	`\`tab\` is an id prefix from \`tabs\`; default is the tab this session used last, or a new tab. \`timeout\` bounds each CDP command and wait in seconds (default ${DEFAULT_TIMEOUT_MS / 1000}); raise it for slow pages and large downloads. Console and network are recorded per tab from its first use. Output over 2000 lines or 50KB is truncated and saved to a file.`,
].join("\n");

const ACTIONS = [
	"tabs",
	"open",
	"close",
	"navigate",
	"download",
	"snapshot",
	"html",
	"eval",
	"screenshot",
	"console",
	"network",
	"cookies",
	"click",
	"type",
	"key",
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
		description: DESCRIPTION,
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
			cookie: Type.Optional(
				Type.String({
					description:
						"JSON object of Network.setCookie/deleteCookies fields. Without url or domain, applies to the tab URL.",
				}),
			),
			method: Type.Optional(Type.String()),
			params: Type.Optional(
				Type.String({
					description:
						'JSON object with every required field, e.g. {"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}',
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					exclusiveMinimum: 0,
					maximum: 2_147_483,
					description: "Seconds for each CDP command and wait",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx): Promise<Result> {
			const { action } = params;
			browser.timeoutMs = params.timeout === undefined ? DEFAULT_TIMEOUT_MS : params.timeout * 1000;
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
				case "download": {
					const url = required(params.url, "url", action);
					const file = await browser.download(tab, url, (status) =>
						ctx.ui.notify(
							`Browser download got HTTP ${status} from ${url}. Complete the check in the Helium window within ${browser.timeoutMs / 1000}s.`,
							"warning",
						),
					);
					return output(`Downloaded ${file.path} (${formatSize(file.bytes)})`);
				}
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
			browser.timeoutMs = DEFAULT_TIMEOUT_MS;
			const [command = "status", mode = "headed"] = args.trim().split(/\s+/).filter(Boolean);
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
