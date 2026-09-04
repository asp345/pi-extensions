export type JsonObject = Record<string, unknown>;
export type ResponseItem = JsonObject & { type?: string };

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneItem<T>(value: T): T {
	return structuredClone(value);
}

export function cloneInputItem(value: ResponseItem): ResponseItem {
	const item = cloneItem(value);
	delete item.status;
	return item;
}

export function isResponseItem(value: unknown): value is ResponseItem {
	if (!isJsonObject(value)) return false;
	return (
		typeof value.type === "string" ||
		(typeof value.role === "string" && (typeof value.content === "string" || Array.isArray(value.content)))
	);
}

export function responseItemText(item: ResponseItem): string {
	if (item.type !== "message" && item.type !== undefined) return "";
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return "";
	return item.content
		.flatMap((part) => (isJsonObject(part) && typeof part.text === "string" ? [part.text] : []))
		.join("");
}

export function approximateTokens(item: ResponseItem): number {
	return Math.max(1, Math.ceil(responseItemText(item).length / 4));
}

export function truncateMiddle(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) return text;
	if (maxCharacters <= 1) return text.slice(-maxCharacters);
	const marker = "…";
	const available = Math.max(0, maxCharacters - marker.length);
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

export function truncateMessage(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
	if ((item.type !== "message" && item.type !== undefined) || maxTokens <= 0) return undefined;
	const copy = cloneItem(item);
	let remainingCharacters = maxTokens * 4;

	if (typeof copy.content === "string") {
		copy.content = truncateMiddle(copy.content, remainingCharacters);
		return copy.content ? copy : undefined;
	}
	if (!Array.isArray(copy.content)) return copy;

	const content = copy.content;
	const textParts = content.filter((part) => isJsonObject(part) && typeof part.text === "string");
	const totalText = textParts.reduce((sum, part) => sum + String(part.text).length, 0);
	let consumed = 0;
	const truncatedContent = content.flatMap((part) => {
		if (!isJsonObject(part) || typeof part.text !== "string") return [part];
		const remainingText = totalText - consumed;
		const partBudget = remainingText === 0 ? 0 : Math.floor((part.text.length / remainingText) * remainingCharacters);
		const text = truncateMiddle(part.text, partBudget);
		consumed += part.text.length;
		remainingCharacters -= partBudget;
		return text ? [{ ...part, text }] : [];
	});
	copy.content = truncatedContent;
	return truncatedContent.length > 0 ? copy : undefined;
}
