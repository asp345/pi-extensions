import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionContext,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	matchesKey,
	type OverlayOptions,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitFrameContent } from "./frame.js";
import type { AgentManager } from "./manager.js";
import { contentText, resolveThinking } from "./runner.js";
import {
	agentOptions,
	cycleOption,
	handleSelectorKey,
	MAIN_OPTION_ID,
	mainOption,
	renderSelectorLines,
	type SelectorState,
	selectorKey,
} from "./selector.js";
import type { AgentRecord, DefinitionRegistry } from "./types.js";
import { message } from "./util.js";

const VIEWPORT_HEIGHT_PERCENT = 70;
const CHROME_ROWS = 6;

const OVERLAY: OverlayOptions = {
	anchor: "center",
	width: "90%",
	maxHeight: `${VIEWPORT_HEIGHT_PERCENT}%`,
};

export type WorkspaceAction = "close" | "definitions" | "create";
export interface WorkspaceResult {
	action: WorkspaceAction;
	selectedId?: string;
}

export async function showAgentWorkspace(
	ctx: ExtensionContext,
	manager: AgentManager,
	registry: () => DefinitionRegistry,
	initial: string | undefined,
	onRefresh: (refresh: (() => void) | undefined) => void,
): Promise<WorkspaceResult> {
	try {
		return await ctx.ui.custom<WorkspaceResult>(
			(tui, theme, keys, done) => {
				let selectedId = initial;
				let focused = true;
				let scrollOffset = 0;
				let autoScroll = true;
				let lastInnerWidth = 1;
				let composer: Input | undefined;
				let cachedContent: { record: AgentRecord | undefined; width: number; lines: string[] } | undefined;
				let toolsExpanded = ctx.ui.getToolsExpanded();
				const selector: SelectorState = { active: false, index: 0 };
				const selectorOptions = () => [mainOption(), ...agentOptions(manager.running())];
				const selected = (): AgentRecord | undefined => {
					const records = manager.list();
					const query = selectedId;
					const exact = query
						? records.find(
								(item) =>
									item.id === query || item.id.startsWith(query) || item.type.toLowerCase() === query.toLowerCase(),
							)
						: undefined;
					const record = exact ?? records[0];
					selectedId = record?.id;
					return record;
				};
				const refresh = () => tui.requestRender();
				const invalidateContent = () => {
					cachedContent = undefined;
				};
				onRefresh(() => {
					invalidateContent();
					refresh();
				});
				queueMicrotask(refresh);
				const leave = (action: WorkspaceAction) => done({ action, selectedId });
				const openComposer = (record: AgentRecord) => {
					const input = new Input();
					input.focused = focused;
					input.onSubmit = (value) => {
						composer = undefined;
						const prompt = value.trim();
						if (!prompt) return refresh();
						scrollOffset = 0;
						autoScroll = true;
						if (record.status === "running") {
							void manager.steer(record.id, prompt).then((accepted) => {
								if (!accepted) ctx.ui.notify("The steering message was rejected.", "warning");
							});
						} else {
							const definition = [...registry().definitions.values()].find(
								(item) => item.name.toLowerCase() === record.type.toLowerCase(),
							);
							void manager
								.resume(ctx, record.id, prompt, {
									background: true,
									models: definition?.models ?? record.models,
									definition,
									thinking: resolveThinking(definition?.thinking, ctx),
									maxTurns: definition?.maxTurns,
								})
								.catch((error) => ctx.ui.notify(message(error), "warning"));
						}
						refresh();
					};
					input.onEscape = () => {
						composer = undefined;
						refresh();
					};
					composer = input;
					refresh();
				};
				const layout = () => {
					const maxRows = Math.max(1, Math.floor((tui.terminal.rows * VIEWPORT_HEIGHT_PERCENT) / 100));
					const showComposerHint = Boolean(composer && maxRows > CHROME_ROWS);
					const chromeRows = CHROME_ROWS + (showComposerHint ? 1 : 0);
					return {
						maxRows,
						contentRows: Math.max(0, maxRows - chromeRows),
						showComposerHint,
						compact: maxRows < CHROME_ROWS,
					};
				};
				const conversationLines = (record: AgentRecord | undefined, width: number): string[] => {
					const cache = cachedContent;
					if (cache && cache.record === record && cache.width === width) return cache.lines;
					let lines: string[];
					if (!record?.session) {
						const text = record ? record.result || record.error || "(session starting)" : "No agent sessions.";
						lines = text
							.split("\n")
							.flatMap((line) => wrapTextWithAnsi(line || " ", width))
							.map((line) => truncateToWidth(line, width));
					} else if (record.session.messages.length === 0) {
						lines = [theme.fg("dim", "(waiting for first message...)")];
					} else {
						const conversation = new Container();
						const pendingTools = new Map<string, ToolExecutionComponent>();
						const markdownTheme = getMarkdownTheme();
						const cwd = record.worktree?.cwd ?? ctx.cwd;
						for (const entry of record.session.messages) {
							if (entry.role === "user") {
								const text = contentText(entry.content).trim();
								if (text) conversation.addChild(new UserMessageComponent(text, markdownTheme, 0));
								continue;
							}
							if (entry.role === "assistant") {
								const assistant = entry as AssistantMessage;
								conversation.addChild(new AssistantMessageComponent(assistant, false, markdownTheme, "Thinking...", 0));
								for (const part of assistant.content) {
									if (part.type !== "toolCall") continue;
									const component = new ToolExecutionComponent(
										part.name,
										part.id,
										part.arguments,
										{ showImages: false },
										record.session.getToolDefinition(part.name),
										tui,
										cwd,
									);
									component.setExpanded(toolsExpanded);
									conversation.addChild(component);
									if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
										component.updateResult({
											content: [{ type: "text", text: assistant.errorMessage || "Agent request failed" }],
											isError: true,
										});
									} else pendingTools.set(part.id, component);
								}
								continue;
							}
							if (entry.role === "toolResult") {
								const component = pendingTools.get(entry.toolCallId);
								if (component) {
									component.updateResult(entry);
									pendingTools.delete(entry.toolCallId);
								}
							}
						}
						lines = conversation.render(width).map((line) => truncateToWidth(line, width));
					}
					cachedContent = { record, width, lines };
					return lines;
				};
				const contentLines = (record: AgentRecord | undefined, width: number): string[] =>
					selector.active
						? renderSelectorLines(
								theme,
								width,
								"Agents",
								"↑↓ choose · enter switch · esc back",
								selectorOptions(),
								selector,
							)
						: conversationLines(record, width);
				const render = (width: number): string[] => {
					if (width < 6) return [];
					const record = selected();
					const currentLayout = layout();
					const innerWidth = width - 4;
					lastInnerWidth = innerWidth;
					const pad = (text: string) => fitFrameContent(text, innerWidth);
					const row = (text: string) => theme.fg("border", "│") + " " + pad(text) + " " + theme.fg("border", "│");
					const status = record
						? record.status === "running"
							? theme.fg("accent", "●")
							: record.status === "completed"
								? theme.fg("success", "✓")
								: theme.fg(record.status === "error" ? "error" : "warning", "○")
						: theme.fg("dim", "○");
					const elapsed = record
						? Math.max(0, Math.round(((record.completedAt ?? Date.now()) - record.startedAt) / 1000))
						: 0;
					const heading = record
						? `${status} ${theme.bold(record.type)} ${theme.fg("muted", `· ${record.model ?? "model pending"} · ${record.status}`)} ${theme.fg("dim", `· ${record.toolUses} tools · ${elapsed}s`)}`
						: theme.fg("dim", "No agent sessions.");
					if (currentLayout.compact) {
						return [row(heading), ...new Array<string>(currentLayout.maxRows - 1).fill("").map(row)];
					}
					const top = theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
					const bottom = theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
					const divider = row(theme.fg("dim", "─".repeat(innerWidth)));
					const lines = [top, row(heading), divider];
					const content = contentLines(record, innerWidth);
					const rows = currentLayout.contentRows;
					const maxScroll = Math.max(0, content.length - rows);
					let visibleOffset = 0;
					if (!selector.active) {
						if (autoScroll) scrollOffset = maxScroll;
						scrollOffset = Math.min(scrollOffset, maxScroll);
						visibleOffset = scrollOffset;
					}
					for (const line of content.slice(visibleOffset, visibleOffset + rows)) lines.push(row(line));
					while (lines.length < 3 + rows) lines.push(row(""));
					lines.push(divider);
					if (composer) {
						lines.push(row(composer.render(innerWidth)[0] ?? ""));
						if (currentLayout.showComposerHint) lines.push(row(theme.fg("dim", "Enter send · Esc cancel")));
					} else {
						const scrollPercent = selector.active
							? "100%"
							: content.length <= rows
								? "100%"
								: `${Math.round(((scrollOffset + rows) / content.length) * 100)}%`;
						const left = selector.active
							? "↑↓ choose · Enter switch · Esc cancel"
							: record
								? "Enter steer · Alt+X stop · Alt+C clear · Alt+D definitions · Alt+N new"
								: "Alt+N new";
						const right = selector.active ? "" : `↑↓ switch · PgUp/PgDn scroll · ${scrollPercent} · Esc parent`;
						const gap = right ? Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right)) : 0;
						lines.push(row(theme.fg("dim", `${left}${" ".repeat(gap)}${right}`)));
					}
					lines.push(bottom);
					return lines;
				};

				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
						if (composer) composer.focused = value;
					},
					render,
					handleInput(data: string) {
						if (composer) {
							composer.handleInput(data);
							refresh();
							return;
						}
						const record = selected();
						if (keys.matches(data, "app.tools.expand")) {
							toolsExpanded = !toolsExpanded;
							invalidateContent();
							refresh();
							return;
						}
						const key = selectorKey(data);
						if (selector.active) {
							const outcome = handleSelectorKey(selector, key, selectorOptions(), true);
							if (outcome.commit) {
								if (outcome.commit.id === MAIN_OPTION_ID) return leave("close");
								selectedId = outcome.commit.id;
								scrollOffset = 0;
								autoScroll = true;
							}
							refresh();
							return;
						}
						if (matchesKey(data, "escape") || data === "q") return leave("close");
						if (matchesKey(data, "enter") && record) return openComposer(record);

						if (lastInnerWidth <= 1) return refresh();
						const content = contentLines(record, lastInnerWidth);
						const rows = layout().contentRows;
						const step = Math.max(1, rows);
						const maxScroll = Math.max(0, content.length - rows);
						if (matchesKey(data, Key.pageUp)) {
							scrollOffset = Math.max(0, scrollOffset - step);
							autoScroll = false;
							return refresh();
						}
						if (matchesKey(data, Key.pageDown)) {
							scrollOffset = Math.min(maxScroll, scrollOffset + step);
							autoScroll = scrollOffset >= maxScroll;
							return refresh();
						}
						if (matchesKey(data, "home")) {
							scrollOffset = 0;
							autoScroll = false;
							return refresh();
						}
						if (matchesKey(data, "end")) {
							scrollOffset = maxScroll;
							autoScroll = true;
							return refresh();
						}

						if (key === "shift+down" || key === "shift+up") {
							const option = cycleOption(selectorOptions(), record?.id, key === "shift+down" ? "next" : "previous");
							selector.active = false;
							if (!option) return;
							if (option.id === MAIN_OPTION_ID) return leave("close");
							selectedId = option.id;
							scrollOffset = 0;
							autoScroll = true;
							return refresh();
						}
						const wasActive = selector.active;
						const outcome = handleSelectorKey(selector, key, selectorOptions(), true);
						if (outcome.commit) {
							if (outcome.commit.id === MAIN_OPTION_ID) return leave("close");
							selectedId = outcome.commit.id;
							scrollOffset = 0;
							autoScroll = true;
						}
						if (outcome.consume || wasActive !== selector.active) {
							refresh();
							if (outcome.consume) return;
						}
						if (matchesKey(data, "alt+x") && record?.status === "running") manager.cancel(record.id);
						else if (matchesKey(data, "alt+d")) return leave("definitions");
						else if (matchesKey(data, "alt+n")) return leave("create");
						else if (matchesKey(data, "alt+c"))
							ctx.ui.notify(`Cleared ${manager.clearFinished(ctx.cwd)} finished agent(s).`, "info");
						refresh();
					},
					invalidate() {
						lastInnerWidth = 1;
						invalidateContent();
						composer?.invalidate();
					},
				};
			},
			{ overlay: true, overlayOptions: OVERLAY },
		);
	} finally {
		onRefresh(undefined);
	}
}
