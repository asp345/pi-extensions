import { type Command, type CommandArgument, forEachChild, parse, type SyntaxNode } from "unbash";

export function argumentText(argument: CommandArgument): string {
	return argument.type === "Word" ? argument.value : argument.text;
}

export function walkCommands(command: string, visit: (node: Command) => void): void {
	const walk = (node: SyntaxNode): void => {
		if (node.type === "Command") visit(node);
		forEachChild(node, walk);
	};
	walk(parse(command));
}
