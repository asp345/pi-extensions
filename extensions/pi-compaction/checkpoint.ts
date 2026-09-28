import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cloneItem, isJsonObject, isResponseItem, type ResponseItem } from "./protocol.ts";

export const NATIVE_COMPACTION_KIND = "openai-codex-native-compaction";
export const NATIVE_COMPACTION_VERSION = 1;
export interface NativeCompactionDetails {
	kind: typeof NATIVE_COMPACTION_KIND;
	version: typeof NATIVE_COMPACTION_VERSION;
	modelKey: string;
	replacementHistory: ResponseItem[];
}

export type CheckpointLookup<T> =
	| { status: "none" }
	| { status: "invalid"; entryIndex: number; entryId: string }
	| { status: "valid"; checkpoint: { entryIndex: number; entryId: string; details: T } };

export function isOpenAICodexModel(model: unknown): model is Model<"openai-codex-responses"> {
	if (!isJsonObject(model)) return false;
	return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function modelKey(model: Pick<Model<Api>, "provider" | "api" | "id">): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isJsonObject(value)) return undefined;
	if (value.kind !== NATIVE_COMPACTION_KIND) return undefined;
	if (typeof value.modelKey !== "string" || !Array.isArray(value.replacementHistory)) return undefined;

	const replacementHistory = value.replacementHistory.filter(isResponseItem);
	if (replacementHistory.length !== value.replacementHistory.length || replacementHistory.length === 0)
		return undefined;
	const compactionItems = replacementHistory.filter((item) => item.type === "compaction");
	if (
		compactionItems.length !== 1 ||
		typeof compactionItems[0]?.encrypted_content !== "string" ||
		replacementHistory.at(-1)?.type !== "compaction"
	) {
		return undefined;
	}

	return {
		kind: NATIVE_COMPACTION_KIND,
		version: NATIVE_COMPACTION_VERSION,
		modelKey: value.modelKey,
		replacementHistory: replacementHistory.map(cloneItem),
	};
}

export function findCheckpoint<T>(
	branch: SessionEntry[],
	kind: string,
	parse: (value: unknown) => T | undefined,
): CheckpointLookup<T> {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;

		let rawDetails: unknown;
		if (entry.type === "compaction") {
			if (!isJsonObject(entry.details) || entry.details.kind !== kind) {
				return { status: "none" };
			}
			rawDetails = entry.details;
		} else if (entry.type === "custom" && entry.customType === kind) {
			rawDetails = entry.data;
		} else {
			continue;
		}

		const details = parse(rawDetails);
		if (!details) return { status: "invalid", entryIndex: index, entryId: entry.id };
		return {
			status: "valid",
			checkpoint: { entryIndex: index, entryId: entry.id, details },
		};
	}
	return { status: "none" };
}

export function findNativeCheckpoint(branch: SessionEntry[]): CheckpointLookup<NativeCompactionDetails> {
	return findCheckpoint(branch, NATIVE_COMPACTION_KIND, parseNativeCompactionDetails);
}
