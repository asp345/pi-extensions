import { type Command, type CommandArgument, parse, type Word } from "unbash";

export function argumentText(argument: CommandArgument): string {
	return argument.type === "Word" ? argument.value : argument.text;
}

export function walkCommands(command: string, visit: (node: Command) => void): void {
	const visited = new WeakSet<object>();
	const walk = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		if (visited.has(value)) return;
		visited.add(value);
		const node = value as Record<string, unknown>;
		if (node.type === "Command") visit(value as Command);
		if ("parts" in node) {
			const parts = (value as Word).parts;
			if (parts) for (const part of parts) walk(part);
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) {
				for (const item of child) walk(item);
			} else {
				walk(child);
			}
		}
	};
	walk(parse(command));
}
