import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BACKGROUND_TASKS_STATE_EVENT, parseBackgroundTasksState } from "../pi-background-tasks/events.ts";
import type { ThinkingLevel } from "./types.ts";

const PARENT_ONLY_TOOLS = ["question", "goal_complete", "goal_blocked"];

const CHILD_GUIDELINES = [
	"You are a subagent launched by a parent agent. The parent does not see your text output; it receives only what you send with send_message.",
	"When the task calls for an answer, send the complete answer with send_message before you finish. Send each finding once; do not repeat earlier messages. You may continue cleanup after sending.",
];

interface ChildSessionOptions {
	cwd: string;
	trusted: boolean;
	sessionFile?: string;
	sessionDir?: string;
	parentSessionFile?: string;
	model?: Model<Api>;
	thinking?: ThinkingLevel;
	sendToParent: (message: string) => void;
	onBackgroundTasks: (runningTaskIds: string[]) => void;
	onExtensionError: (message: string) => void;
}

function childExtension(options: ChildSessionOptions) {
	return (pi: ExtensionAPI): void => {
		pi.events.on(BACKGROUND_TASKS_STATE_EVENT, (data) => {
			const state = parseBackgroundTasksState(data);
			if (state) options.onBackgroundTasks(state.runningTaskIds);
		});
		pi.registerTool({
			name: "send_message",
			label: "Send Message",
			description:
				"Send a message to the parent agent. The parent receives it as a message from this subagent and starts a turn to handle it.",
			promptSnippet: "Send a message to the parent agent",
			promptGuidelines: CHILD_GUIDELINES,
			parameters: Type.Object({
				message: Type.String({ minLength: 1, maxLength: 12_000 }),
			}),
			async execute(_toolCallId, params) {
				const message = params.message.trim();
				if (!message) throw new Error("Message must not be blank.");
				options.sendToParent(message);
				return { content: [{ type: "text", text: "Message delivered to the parent." }], details: {} };
			},
		});
	};
}

function openSessionManager(options: ChildSessionOptions): SessionManager {
	if (options.sessionFile) return SessionManager.open(options.sessionFile);
	if (options.sessionDir) {
		return SessionManager.create(options.cwd, options.sessionDir, { parentSession: options.parentSessionFile });
	}
	return SessionManager.inMemory(options.cwd, { parentSession: options.parentSessionFile });
}

export async function createChildSession(options: ChildSessionOptions): Promise<AgentSession> {
	const agentDir = getAgentDir();
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir,
		settingsManager: SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.trusted }),
		resourceLoaderOptions: {
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [{ name: "pi-subagents-child", factory: childExtension(options), hidden: true }],
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((extension) => !extension.tools.has("launch_subagent")),
			}),
		},
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: openSessionManager(options),
		model: options.model,
		thinkingLevel: options.thinking,
		excludeTools: PARENT_ONLY_TOOLS,
	});
	await session.bindExtensions({
		mode: "print",
		onError: (error) => options.onExtensionError(`Extension error (${error.extensionPath}): ${error.error}`),
	});
	return session;
}

export async function closeChildSession(session: AgentSession): Promise<void> {
	await session.abort();
	if (session.extensionRunner.hasHandlers("session_shutdown")) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	}
	session.dispose();
}
