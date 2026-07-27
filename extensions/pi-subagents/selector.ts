import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export const MAIN_OPTION_ID = "main";

export interface SelectorOption {
	id: string;
	label: string;
	detail: string;
}

export interface SelectorState {
	active: boolean;
	index: number;
}

export interface SelectorResult {
	consume: boolean;
	commit?: SelectorOption;
}

export interface SelectorTheme {
	fg(color: "accent" | "dim" | "text", text: string): string;
	bold(text: string): string;
}

export type SelectorKeyName = "up" | "down" | "shift+up" | "shift+down" | "enter" | "escape";

export function selectorKey(data: string): SelectorKeyName | undefined {
	if (matchesKey(data, "shift+down")) return "shift+down";
	if (matchesKey(data, "shift+up")) return "shift+up";
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.enter)) return "enter";
	if (matchesKey(data, Key.escape)) return "escape";
	return undefined;
}

export function agentOptions(
	records: readonly { id: string; type: string; turns: number; toolUses: number }[],
): SelectorOption[] {
	return records.map((record) => ({
		id: record.id,
		label: record.type,
		detail: `${record.id.slice(0, 8)} · ${record.turns} turns · ${record.toolUses} tools`,
	}));
}

export function mainOption(): SelectorOption {
	return { id: MAIN_OPTION_ID, label: "Main", detail: "return to the parent session" };
}

export function handleSelectorKey(
	state: SelectorState,
	key: SelectorKeyName | undefined,
	options: readonly SelectorOption[],
	editorEmpty: boolean,
): SelectorResult {
	if (!options.length) {
		state.active = false;
		state.index = 0;
		return { consume: false };
	}
	state.index = Math.min(state.index, options.length - 1);
	if (!state.active) {
		if (key === "shift+down" || key === "shift+up" || (key === "down" && editorEmpty)) {
			state.active = true;
			state.index = 0;
			return { consume: true };
		}
		return { consume: false };
	}
	if (key === "down" || key === "shift+down") {
		state.index = Math.min(options.length - 1, state.index + 1);
		return { consume: true };
	}
	if (key === "up" || key === "shift+up") {
		if (state.index === 0) state.active = false;
		else state.index -= 1;
		return { consume: true };
	}
	if (key === "enter") {
		const commit = options[state.index];
		state.active = false;
		return { consume: true, commit };
	}
	if (key === "escape") {
		state.active = false;
		return { consume: true };
	}
	state.active = false;
	return { consume: false };
}

export function renderSelectorLines(
	theme: SelectorTheme,
	width: number,
	title: string,
	hint: string,
	options: readonly SelectorOption[],
	state: SelectorState,
	visible = 6,
): string[] {
	const index = Math.min(state.index, Math.max(0, options.length - 1));
	const start = Math.max(0, Math.min(index, options.length - visible));
	return [
		truncateToWidth(`${theme.fg("accent", theme.bold(title))} ${theme.fg("dim", hint)}`, width),
		...options.slice(start, start + visible).map((option, offset) => {
			const selected = state.active && start + offset === index;
			const marker = selected ? theme.fg("accent", "●") : theme.fg("dim", "○");
			return truncateToWidth(
				`  ${marker} ${theme.fg(selected ? "accent" : "text", option.label)} ${theme.fg("dim", option.detail)}`,
				width,
			);
		}),
	];
}

export interface PaddingState {
	key?: string;
	value: number;
}

export function stablePadding(
	state: PaddingState,
	recordId: string | undefined,
	rows: number,
	content: number,
): number {
	const key = `${recordId ?? "none"}|${rows}`;
	if (state.key !== key) {
		state.key = key;
		state.value = Math.max(0, rows - content);
	}
	return state.value;
}
