import {
	AssistantMessageComponent,
	CustomEditor,
	type ExtensionContext,
	FooterComponent,
	getMarkdownTheme,
	getSelectListTheme,
	SettingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentManager } from "./manager.js";
import { contentText, resolveThinking } from "./runner.js";
import {
	agentOptions,
	cycleOption,
	handleSelectorKey,
	MAIN_OPTION_ID,
	mainOption,
	type PaddingState,
	renderSelectorLines,
	type SelectorState,
	selectorKey,
	stablePadding,
} from "./selector.js";
import type { AgentRecord, DefinitionRegistry } from "./types.js";
import { message } from "./util.js";

export type WorkspaceAction = "close" | "definitions" | "create";
export interface WorkspaceResult {
	action: WorkspaceAction;
	selectedId?: string;
}

// Scrollback stability: Pi's TUI cannot observe the native scrollback position.
// Its differential renderer performs a full redraw (ESC[2J + ESC[3J, which
// clears scrollback and snaps the viewport to the live screen) whenever a
// previously rendered line above the live viewport changes. To keep native
// scrolling usable during streaming, rendering is append-only: settled messages
// are rendered once and their lines are frozen, and any block (one message or
// tool component) that has scrolled entirely above the viewport is locked and
// reused verbatim on later frames, so only content inside the viewport may
// change. Locking is block-granular because locked blocks never change line
// count, which keeps every line index below them stable. Trade-off: a block
// locked in a transitional state (e.g. a tool header still pending) keeps that
// rendering in the scrollback.
export async function showAgentWorkspace(
	ctx: ExtensionContext,
	manager: AgentManager,
	registry: () => DefinitionRegistry,
	initial: string | undefined,
	onRefresh: (refresh: (() => void) | undefined) => void,
): Promise<WorkspaceResult> {
	const settings = SettingsManager.create(ctx.cwd);
	let footer: FooterComponent | undefined;
	let footerMounted = false;
	let workspaceOpen = true;
	try {
		return await ctx.ui.custom<WorkspaceResult>(
			(tui, theme, keys, done) => {
				let selectedId = initial;
				let focused = true;
				const padding: PaddingState = { value: 0 };
				const lockedBlocks = new Map<string, string[]>();
				let frameKey = "";
				const selector: SelectorState = { active: false, index: 0 };
				type NativeComponent = { render(width: number): string[]; invalidate?(): void };
				interface CacheEntry {
					source: object;
					component: NativeComponent;
					lines?: string[];
					width?: number;
				}
				const cache = new Map<string, CacheEntry>();
				let cachedRecordId: string | undefined;
				let cachedFirstMessage: object | undefined;
				let cachedMessageCount = 0;
				const markdownTheme = getMarkdownTheme();
				const editor = new CustomEditor(
					tui,
					{
						borderColor: theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off"),
						selectList: getSelectListTheme(),
					},
					keys,
					{
						paddingX: settings.getEditorPaddingX(),
						autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
					},
				);
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
				let footerRecordId: string | undefined;
				const syncFooter = () => {
					if (!workspaceOpen) return;
					const record = selected();
					const session = record?.session;
					if (!session) {
						if (footerMounted) ctx.ui.setFooter(undefined);
						footer = undefined;
						footerMounted = false;
						footerRecordId = undefined;
						return;
					}
					if (!footerMounted) {
						ctx.ui.setFooter((_tui, _theme, footerData) => {
							footer = new FooterComponent(session, footerData);
							return footer;
						});
						footerMounted = true;
					} else if (footerRecordId !== record.id) footer?.setSession(session);
					footerRecordId = record.id;
				};
				const refresh = () => {
					syncFooter();
					tui.requestRender();
				};
				onRefresh(refresh);
				queueMicrotask(refresh);
				const leave = (action: WorkspaceAction) => done({ action, selectedId });
				const conversation = (record: AgentRecord, width: number): { key: string; lines: string[] }[] => {
					const messages = [...(record.session?.agent.state.messages ?? [])];
					const firstMessage = messages[0] as object | undefined;
					if (
						cachedRecordId !== record.id ||
						messages.length < cachedMessageCount ||
						(cachedFirstMessage && firstMessage !== cachedFirstMessage)
					) {
						cache.clear();
						lockedBlocks.clear();
					}
					cachedRecordId = record.id;
					cachedFirstMessage = firstMessage;
					cachedMessageCount = messages.length;
					const calls = new Map<string, { name?: string; arguments?: unknown }>();
					const resultIds = new Set<string>();
					for (const message of messages) {
						if (message.role === "toolResult") resultIds.add(message.toolCallId);
						if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
						for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
					}
					const blocks: { key: string; lines: string[] }[] = [];
					const activeKeys = new Set<string>();
					const streaming = record.status === "running";
					const emit = (
						key: string,
						source: object,
						component: NativeComponent,
						frozen: boolean,
						update: () => void,
					) => {
						activeKeys.add(key);
						const entry = cache.get(key);
						if (frozen && entry?.component === component && entry.lines && entry.width === width) {
							blocks.push({ key, lines: entry.lines });
							return;
						}
						update();
						const rendered = component.render(Math.max(1, width));
						cache.set(key, {
							source,
							component,
							lines: frozen ? rendered : undefined,
							width: frozen ? width : undefined,
						});
						blocks.push({ key, lines: rendered });
					};
					const toolComponent = (callId: string, name: string, args: unknown): ToolExecutionComponent => {
						const entry = cache.get(`c:${callId}`);
						if (entry?.component instanceof ToolExecutionComponent) return entry.component;
						const tool = new ToolExecutionComponent(
							name,
							callId,
							args ?? {},
							{ showImages: false },
							undefined,
							tui,
							record.worktree?.cwd ?? ctx.cwd,
						);
						tool.markExecutionStarted();
						return tool;
					};
					for (const [index, message] of messages.entries()) {
						const settled = !streaming || index < messages.length - 1;
						if (message.role === "user") {
							const key = `m:${index}`;
							const entry = cache.get(key);
							const component =
								entry?.source === message && entry.component instanceof UserMessageComponent
									? entry.component
									: new UserMessageComponent(contentText(message.content), markdownTheme, 1);
							emit(key, message, component, true, () => undefined);
						} else if (message.role === "assistant") {
							const key = `m:${index}`;
							const entry = cache.get(key);
							const component =
								entry?.component instanceof AssistantMessageComponent
									? entry.component
									: new AssistantMessageComponent(message, false, markdownTheme, "Thinking…", 1);
							emit(key, message, component, settled, () => component.updateContent(message));
							if (!Array.isArray(message.content)) continue;
							for (const part of message.content) {
								if (part.type !== "toolCall" || resultIds.has(part.id)) continue;
								const tool = toolComponent(part.id, part.name || "tool", part.arguments);
								emit(`c:${part.id}`, message, tool, false, () => {
									tool.updateArgs(part.arguments ?? {});
									if (settled) tool.setArgsComplete();
								});
							}
						} else if (message.role === "toolResult") {
							const call = calls.get(message.toolCallId);
							const tool = toolComponent(message.toolCallId, message.toolName || call?.name || "tool", call?.arguments);
							emit(`c:${message.toolCallId}`, message, tool, settled, () => {
								tool.setArgsComplete();
								tool.updateResult({ content: message.content, details: message.details, isError: message.isError });
							});
						}
					}
					for (const key of cache.keys()) if (!activeKeys.has(key)) cache.delete(key);
					return blocks;
				};
				const send = (value: string) => {
					const record = selected();
					const prompt = value.trim();
					if (!record || !prompt) return;
					editor.addToHistory(prompt);
					editor.setText("");
					if (record.status === "running") manager.steer(record.id, prompt);
					else {
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
				editor.focused = true;
				editor.onSubmit = send;
				editor.onEscape = () => leave("close");

				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
						editor.focused = value;
					},
					render(width: number) {
						const record = selected();
						editor.borderColor = theme.getThinkingBorderColor(
							record?.session?.thinkingLevel ?? record?.thinking ?? ctx.thinkingLevel ?? "off",
						);
						const rows = Math.max(7, tui.terminal.rows);
						const key = `${record?.id ?? "none"}|${width}`;
						if (key !== frameKey) {
							frameKey = key;
							lockedBlocks.clear();
						}
						const editorLines = editor.render(width);
						const selectorLines = selector.active
							? renderSelectorLines(
									theme,
									width,
									"Agents",
									"↑↓ choose · enter switch · esc back",
									selectorOptions(),
									selector,
								)
							: [];
						const footer = truncateToWidth(
							theme.fg(
								"dim",
								record
									? "Alt+X cancel · Alt+C clear · Alt+D definitions · Alt+N new · Shift+↑↓ switch · Esc parent"
									: "Alt+N definitions · Shift+↑↓ switch · Esc parent",
							),
							width,
						);
						const border = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
						let body: string[];
						let pad: number;
						if (record?.session) {
							const blocks = conversation(record, width);
							const emitted = blocks.map((block) => lockedBlocks.get(block.key) ?? block.lines);
							const bodyLength = emitted.reduce((total, lines) => total + lines.length, 0);
							const contentLength = 1 + bodyLength + editorLines.length + selectorLines.length + 1;
							pad = stablePadding(padding, record.id, rows, contentLength);
							const horizon = Math.max(0, pad + contentLength - rows);
							let cursor = pad + 1;
							body = [];
							for (const [index, block] of blocks.entries()) {
								const lines = emitted[index];
								if (!lockedBlocks.has(block.key) && cursor + lines.length <= horizon)
									lockedBlocks.set(block.key, block.lines);
								body.push(...lines);
								cursor += lines.length;
							}
						} else {
							body = (record ? record.result || record.error || "(session starting)" : "No agent sessions.")
								.split("\n")
								.flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width - 1)))
								.map((line) => ` ${line}`);
							pad = stablePadding(
								padding,
								record?.id,
								rows,
								1 + body.length + editorLines.length + selectorLines.length + 1,
							);
						}
						return [...new Array<string>(pad).fill(""), border, ...body, ...editorLines, ...selectorLines, footer];
					},
					handleInput(data: string) {
						const record = selected();
						const key = selectorKey(data);
						if (key === "shift+down" || key === "shift+up") {
							const option = cycleOption(selectorOptions(), record?.id, key === "shift+down" ? "next" : "previous");
							selector.active = false;
							if (!option) return;
							if (option.id === MAIN_OPTION_ID) leave("close");
							else {
								selectedId = option.id;
								refresh();
							}
							return;
						}
						const wasActive = selector.active;
						const outcome = handleSelectorKey(selector, key, selectorOptions(), editor.getText().length === 0);
						if (outcome.commit) {
							if (outcome.commit.id === MAIN_OPTION_ID) {
								leave("close");
								return;
							}
							selectedId = outcome.commit.id;
						}
						if (outcome.consume || wasActive !== selector.active) {
							refresh();
							if (outcome.consume) return;
						}
						if (matchesKey(data, "alt+x") && record?.status === "running") manager.cancel(record.id);
						else if (matchesKey(data, "alt+d")) {
							leave("definitions");
							return;
						} else if (matchesKey(data, "alt+n")) {
							leave("create");
							return;
						} else if (matchesKey(data, "alt+c"))
							ctx.ui.notify(`Cleared ${manager.clearFinished(ctx.cwd)} finished agent(s).`, "info");
						else editor.handleInput(data);
						refresh();
					},
					invalidate() {
						editor.invalidate();
						for (const { component } of cache.values()) component.invalidate?.();
						lockedBlocks.clear();
					},
				};
			},
			{ overlay: false },
		);
	} finally {
		workspaceOpen = false;
		onRefresh(undefined);
		if (footerMounted) ctx.ui.setFooter(undefined);
	}
}
