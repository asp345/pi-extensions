interface AxValue {
	value?: unknown;
}

export interface AxNode {
	nodeId: string;
	parentId?: string;
	childIds?: string[];
	role?: AxValue;
	name?: AxValue;
	value?: AxValue;
}

const HIDDEN_ROLES = new Set(["none", "generic", "InlineTextBox"]);

function text(value: AxValue | undefined): string {
	const raw = value?.value;
	if (raw === undefined || raw === null) return "";
	return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export function formatAxTree(nodes: AxNode[]): string {
	const byId = new Map(nodes.map((node) => [node.nodeId, node]));
	const childrenOf = new Map<string, AxNode[]>();
	for (const node of nodes) {
		if (!node.parentId) continue;
		const siblings = childrenOf.get(node.parentId) ?? [];
		siblings.push(node);
		childrenOf.set(node.parentId, siblings);
	}

	const lines: string[] = [];
	const visited = new Set<string>();
	const visit = (node: AxNode, depth: number, parentName: string): void => {
		if (visited.has(node.nodeId)) return;
		visited.add(node.nodeId);
		const role = text(node.role);
		const name = text(node.name);
		const value = text(node.value);
		const duplicate = role === "StaticText" && name === parentName;
		const shown = !HIDDEN_ROLES.has(role) && !duplicate && (name !== "" || value !== "");
		if (shown) {
			let line = `${"  ".repeat(Math.min(depth, 10))}[${role}]`;
			if (name) line += ` ${name}`;
			if (value) line += ` = ${JSON.stringify(value)}`;
			lines.push(line);
		}
		const children = [
			...(node.childIds ?? []).flatMap((id) => byId.get(id) ?? []),
			...(childrenOf.get(node.nodeId) ?? []),
		];
		for (const child of children) visit(child, shown ? depth + 1 : depth, shown ? name : parentName);
	};

	for (const node of nodes) if (!node.parentId || !byId.has(node.parentId)) visit(node, 0, "");
	for (const node of nodes) visit(node, 0, "");
	return lines.join("\n");
}
