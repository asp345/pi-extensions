import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { contentText } from "./runner.js";
import type { AgentRecord } from "./types.js";

type NativeComponent = { render(width: number): string[]; invalidate?(): void };

type AgentMessage = NonNullable<AgentRecord["session"]>["agent"]["state"]["messages"][number];
type ToolCall = { id?: string; name?: string; arguments?: unknown };

interface Block {
	key: string;
	message: AgentMessage;
	/** Rendered lines can be cached because the block can no longer change. */
	settled: boolean;
	call?: ToolCall;
	/** The call's arguments are fully streamed, so the tool header can stop showing them as pending. */
	argsComplete?: boolean;
}

interface CacheEntry {
	source: object;
	component: NativeComponent;
	lines?: string[];
	width?: number;
}

/**
 * Renders a subagent session with Pi's own message and tool components.
 * Settled blocks keep their rendered lines, so a streaming turn only re-renders
 * the block that is still changing.
 */
export class ConversationView {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly markdownTheme = getMarkdownTheme();
	private recordId?: string;
	private firstMessage?: object;
	private messageCount = 0;

	constructor(
		private readonly tui: TUI,
		private readonly cwd: string,
	) {}

	/**
	 * The last `rows` lines of the session. Blocks are rendered from the end
	 * until the budget is met, so cost stays bounded however long the session is.
	 */
	tail(record: AgentRecord, width: number, rows: number): string[] {
		const plan = this.plan(record);
		const lines: string[] = [];
		for (let index = plan.length - 1; index >= 0 && lines.length < rows; index -= 1) {
			lines.unshift(...this.render(record, plan[index], width));
		}
		return lines.slice(Math.max(0, lines.length - rows));
	}

	/** Cheap descriptors for every block; nothing is rendered here. */
	private plan(record: AgentRecord): Block[] {
		const messages = [...(record.session?.agent.state.messages ?? [])];
		const firstMessage = messages[0] as object | undefined;
		if (
			this.recordId !== record.id ||
			messages.length < this.messageCount ||
			(this.firstMessage && firstMessage !== this.firstMessage)
		) {
			this.cache.clear();
		}
		this.recordId = record.id;
		this.firstMessage = firstMessage;
		this.messageCount = messages.length;
		const calls = new Map<string, { name?: string; arguments?: unknown }>();
		const resultIds = new Set<string>();
		for (const message of messages) {
			if (message.role === "toolResult") resultIds.add(message.toolCallId);
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
		}
		const streaming = record.status === "running";
		const blocks: Block[] = [];
		for (const [index, message] of messages.entries()) {
			const settled = !streaming || index < messages.length - 1;
			if (message.role === "user" || message.role === "assistant") {
				blocks.push({ key: `m:${index}`, message, settled: message.role === "user" || settled });
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const part of message.content) {
					if (part.type !== "toolCall" || resultIds.has(part.id)) continue;
					blocks.push({ key: `c:${part.id}`, message, settled: false, call: part, argsComplete: settled });
				}
			} else if (message.role === "toolResult") {
				blocks.push({ key: `c:${message.toolCallId}`, message, settled, call: calls.get(message.toolCallId) });
			}
		}
		const keys = new Set(blocks.map((block) => block.key));
		for (const key of this.cache.keys()) if (!keys.has(key)) this.cache.delete(key);
		return blocks;
	}

	private render(record: AgentRecord, block: Block, width: number): string[] {
		const entry = this.cache.get(block.key);
		if (block.settled && entry?.lines && entry.width === width && entry.source === block.message) return entry.lines;
		const message = block.message;
		let component: NativeComponent;
		if (block.key.startsWith("c:")) {
			const call = block.call;
			const tool = this.toolComponent(record, block, call);
			if (message.role === "toolResult") {
				tool.setArgsComplete();
				tool.updateResult({ content: message.content, details: message.details, isError: message.isError });
			} else {
				tool.updateArgs(call?.arguments ?? {});
				if (block.argsComplete) tool.setArgsComplete();
			}
			component = tool;
		} else if (message.role === "user") {
			component =
				entry?.component instanceof UserMessageComponent && entry.source === message
					? entry.component
					: new UserMessageComponent(contentText(message.content), this.markdownTheme, 1);
		} else if (message.role === "assistant") {
			const assistant =
				entry?.component instanceof AssistantMessageComponent
					? entry.component
					: new AssistantMessageComponent(message, false, this.markdownTheme, "Thinking\u2026", 1);
			assistant.updateContent(message);
			component = assistant;
		} else {
			return [];
		}
		const lines = component.render(Math.max(1, width));
		this.cache.set(block.key, {
			source: message,
			component,
			lines: block.settled ? lines : undefined,
			width: block.settled ? width : undefined,
		});
		return lines;
	}

	invalidate(): void {
		for (const { component } of this.cache.values()) component.invalidate?.();
	}

	private toolComponent(record: AgentRecord, block: Block, call: ToolCall | undefined): ToolExecutionComponent {
		const entry = this.cache.get(block.key);
		if (entry?.component instanceof ToolExecutionComponent) return entry.component;
		const message = block.message;
		const callId = message.role === "toolResult" ? message.toolCallId : (call?.id ?? block.key.slice(2));
		const name = (message.role === "toolResult" ? message.toolName : undefined) || call?.name || "tool";
		const tool = new ToolExecutionComponent(
			name,
			callId,
			call?.arguments ?? {},
			{ showImages: false },
			undefined,
			this.tui,
			record.worktree?.cwd ?? this.cwd,
		);
		tool.markExecutionStarted();
		return tool;
	}
}
