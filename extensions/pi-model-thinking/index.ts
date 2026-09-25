import { type AgentSession, InteractiveMode, type SettingsManager } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi-model-thinking:patched");

interface ModeInternals {
	session: AgentSession;
	settingsManager: SettingsManager;
}

function rememberLevel(mode: InteractiveMode): void {
	const { session, settingsManager } = mode as unknown as ModeInternals;
	const model = session.model;
	if (model) settingsManager.setModelThinkingLevel(model.provider, model.id, session.thinkingLevel);
}

function afterUserChange(name: "cycleThinkingLevel" | "selectThinkingLevel"): void {
	const prototype = InteractiveMode.prototype;
	const base = Reflect.get(prototype, name) as (this: InteractiveMode, ...args: unknown[]) => unknown;
	Reflect.set(prototype, name, function (this: InteractiveMode, ...args: unknown[]) {
		const result = base.apply(this, args);
		rememberLevel(this);
		return result;
	});
}

export default function modelThinkingExtension(): void {
	const prototype = InteractiveMode.prototype;
	if (Reflect.get(prototype, PATCHED) === true) return;
	afterUserChange("cycleThinkingLevel");
	afterUserChange("selectThinkingLevel");
	Reflect.set(prototype, PATCHED, true);
}
