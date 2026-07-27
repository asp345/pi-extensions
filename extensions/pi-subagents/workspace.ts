import {
	AssistantMessageComponent,
	CustomEditor,
	type ExtensionContext,
	getMarkdownTheme,
	getSelectListTheme,
	SettingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentManager } from "./manager.js";
import { resolveThinking } from "./runner.js";
import {
	agentOptions,
	handleSelectorKey,
	MAIN_OPTION_ID,
	mainOption,
	type PaddingState,
	renderSelectorLines,
	selectorKey,
	type SelectorState,
	stablePadding,
} from "./selector.js";
import type { AgentRecord, DefinitionRegistry } from "./types.js";

export type WorkspaceAction = "close" | "definitions" | "create";
export interface WorkspaceResult {
	action: WorkspaceAction;
	selectedId?: string;
}

// Scrollback stability: Pi's TUI cannot observe the native scrollback position.
// Its differential renderer performs a full redraw (ESC[2J + ESC[3J, which
// clears scrollback and snaps the viewport to the live screen) whenever a
// previously rendered line above the live viewport changes. To keep native
// scrolling usable during streaming, settled messages are rendered once and
// their lines are frozen; only the in-flight tail, editor, and status rows may
// change between frames, and the top padding is fixed per record and terminal
// height. Remaining limitation: a single in-flight message taller than the
// screen can still re-wrap lines above the viewport and force a full redraw;
// that case is not avoidable through the public component API.
export async function showAgentWorkspace(
	ctx: ExtensionContext,
	manager: AgentManager,
	registry: () => DefinitionRegistry,
	initial: string | undefined,
	onRefresh: (refresh: (() => void) | undefined) => void,
): Promise<WorkspaceResult> {
	const settings = SettingsManager.create(ctx.cwd);
	try {
		return await ctx.ui.custom<WorkspaceResult>(
			(tui, theme, keys, done) => {
				let selectedId = initial;
				let focused = true;
				const padding: PaddingState = { value: 0 };
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
						borderColor: (text) => theme.fg("borderMuted", text),
						selectList: getSelectListTheme(),
					},
					keys,
					{
						paddingX: settings.getEditorPaddingX(),
						autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
					},
				);
				const refresh = () => tui.requestRender();
				onRefresh(refresh);

				const running = (): AgentRecord[] =>
					manager
						.list()
						.filter((record) => record.status === "running")
						.sort((a, b) => a.startedAt - b.startedAt);
				const selectorOptions = () => [mainOption(), ...agentOptions(running())];
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
				const leave = (action: WorkspaceAction) => done({ action, selectedId });
				const contentText = (content: unknown): string => {
					if (typeof content === "string") return content;
					if (!Array.isArray(content)) return "";
					return content
						.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
						.map((part) => String((part as { text?: unknown }).text ?? ""))
						.join("\n");
				};
				const conversation = (record: AgentRecord, width: number): string[] => {
					const messages = [...(record.session?.agent.state.messages ?? [])];
					const firstMessage = messages[0] as object | undefined;
					if (
						cachedRecordId !== record.id ||
						messages.length < cachedMessageCount ||
						(cachedFirstMessage && firstMessage !== cachedFirstMessage)
					)
						cache.clear();
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
					const lines: string[] = [];
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
							lines.push(...entry.lines);
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
						lines.push(...rendered);
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
					return lines;
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
							.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"));
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
						const rows = Math.max(7, tui.terminal.rows);
						const definition =
							record &&
							[...registry().definitions.values()].find(
								(item) => item.name.toLowerCase() === record.type.toLowerCase(),
							);
						const metadata = record
							? [
									truncateToWidth(
										`${theme.fg("accent", theme.bold(definition?.displayName ?? record.type))}${theme.fg("dim", ` · ${record.model ?? definition?.models[0] ?? "parent"} · ${record.thinking ?? definition?.thinking ?? "off"}${record.usedFallback ? " · fallback" : ""}`)}`,
										width,
									),
									truncateToWidth(
										theme.fg(
											record.status === "running" ? "warning" : record.error ? "error" : "success",
											`${record.status} · ${record.turns} turns · ${record.toolUses} tools · ${record.id}`,
										),
										width,
									),
								]
							: [truncateToWidth(theme.fg("accent", theme.bold("Agents")), width)];
						const fallback = record?.result || record?.error || "(session starting)";
						const body = record?.session
							? conversation(record, width)
							: fallback
									.split("\n")
									.flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width - 1)))
									.map((line) => ` ${line}`);
						const footer = truncateToWidth(
							theme.fg(
								"dim",
								record
									? "Alt+X cancel · Alt+C clear · Alt+D definitions · Alt+N new · Shift+↓ agents · Esc parent"
									: "Alt+N definitions · Shift+↓ agents · Esc parent",
							),
							width,
						);
						const workspace = [
							theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
							...body,
							...editor.render(width),
							...(selector.active
								? renderSelectorLines(
										theme,
										width,
										"Agents",
										"↑↓ choose · enter switch · esc back",
										selectorOptions(),
										selector,
									)
								: []),
							...metadata,
							footer,
						];
						const pad = stablePadding(padding, record?.id, rows, workspace.length);
						return [...new Array<string>(pad).fill(""), ...workspace];
					},
					handleInput(data: string) {
						const record = selected();
						const wasActive = selector.active;
						const outcome = handleSelectorKey(
							selector,
							selectorKey(data),
							selectorOptions(),
							editor.getText().length === 0,
						);
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
					},
				};
			},
			{ overlay: false },
		);
	} finally {
		onRefresh(undefined);
	}
}
