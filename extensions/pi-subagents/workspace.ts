import {
	CustomEditor,
	type ExtensionContext,
	FooterComponent,
	getSelectListTheme,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type OverlayOptions, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ConversationView } from "./conversation.js";
import { BORDER_ROWS, frame, innerWidth, viewport } from "./frame.js";
import type { AgentManager } from "./manager.js";
import { resolveThinking } from "./runner.js";
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

/** Rows left to the session footer, which reports the selected agent. */
const FOOTER_ROWS = 2;
const OVERLAY_HEIGHT_PERCENT = 85;

/** The box floats over the parent session while leaving its context visible around the edges. */
const OVERLAY: OverlayOptions = {
	anchor: "center",
	margin: { bottom: FOOTER_ROWS },
	width: "90%",
	maxHeight: `${OVERLAY_HEIGHT_PERCENT}%`,
};

/** Height the TUI grants the overlay for {@link OVERLAY}, in rows. */
const boxRows = (terminalRows: number): number =>
	Math.max(
		1,
		Math.min(Math.floor((terminalRows * OVERLAY_HEIGHT_PERCENT) / 100), Math.max(1, terminalRows - FOOTER_ROWS)),
	);

export type WorkspaceAction = "close" | "definitions" | "create";
export interface WorkspaceResult {
	action: WorkspaceAction;
	selectedId?: string;
}

// The workspace is a bordered overlay that owns its own viewport
// instead of the terminal's native scrollback: the conversation is fetched
// from the tail, and PgUp/PgDn move a scroll offset counted in lines from the
// bottom. Keeping the box no taller than the screen matters, because content
// that changes above the live viewport would force the renderer into full
// redraws that clear native scrollback.
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
				let scroll = 0;
				let viewportRows = 1;
				const selector: SelectorState = { active: false, index: 0 };
				const conversation = new ConversationView(tui, ctx.cwd);
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
				const send = (value: string) => {
					const record = selected();
					const prompt = value.trim();
					if (!record || !prompt) return;
					editor.addToHistory(prompt);
					editor.setText("");
					scroll = 0;
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
				const bodyLines = (record: AgentRecord | undefined, inner: number, rows: number): string[] =>
					record?.session
						? conversation.tail(record, inner, rows)
						: (record ? record.result || record.error || "(session starting)" : "No agent sessions.")
								.split("\n")
								.flatMap((line) => wrapTextWithAnsi(line || " ", inner));
				const hintLine = (record: AgentRecord | undefined, inner: number): string =>
					truncateToWidth(
						theme.fg(
							"dim",
							record
								? "Alt+X cancel · Alt+C clear · Alt+D definitions · Alt+N new · Shift+↑↓ switch · PgUp/PgDn scroll · Esc parent"
								: "Alt+N definitions · Shift+↑↓ switch · Esc parent",
						),
						inner,
					);
				const title = (record: AgentRecord | undefined): string => {
					if (!record) return "Agents";
					const suffix = scroll > 0 ? ` · scrolled ${scroll}` : "";
					return `${record.type} · ${record.status}${suffix}`;
				};

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
						const inner = innerWidth(width);
						const selectorLines = selector.active
							? renderSelectorLines(
									theme,
									inner,
									"Agents",
									"↑↓ choose · enter switch · esc back",
									selectorOptions(),
									selector,
								)
							: [];
						// The editor comes first so it survives when a short terminal cannot
						// fit the selector and the key hint below it.
						const available = Math.max(0, boxRows(tui.terminal.rows) - BORDER_ROWS);
						const chrome = [...editor.render(inner), ...selectorLines, hintLine(record, inner)].slice(0, available);
						viewportRows = available - chrome.length;
						// Fetching only what the viewport and the scroll offset need keeps a
						// long session from being re-rendered in full on every frame.
						const view = viewport(bodyLines(record, inner, viewportRows + scroll), viewportRows, scroll);
						scroll = view.scroll;
						return frame([...view.lines, ...chrome], width, theme, title(record));
					},
					handleInput(data: string) {
						const record = selected();
						const pageUp = matchesKey(data, Key.pageUp);
						if (pageUp || matchesKey(data, Key.pageDown)) {
							const step = Math.max(1, viewportRows - 1);
							scroll = Math.max(0, scroll + (pageUp ? step : -step));
							refresh();
							return;
						}
						const key = selectorKey(data);
						if (key === "shift+down" || key === "shift+up") {
							const option = cycleOption(selectorOptions(), record?.id, key === "shift+down" ? "next" : "previous");
							selector.active = false;
							if (!option) return;
							if (option.id === MAIN_OPTION_ID) leave("close");
							else {
								selectedId = option.id;
								scroll = 0;
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
							scroll = 0;
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
						conversation.invalidate();
					},
				};
			},
			{ overlay: true, overlayOptions: OVERLAY },
		);
	} finally {
		workspaceOpen = false;
		onRefresh(undefined);
		if (footerMounted) ctx.ui.setFooter(undefined);
	}
}
