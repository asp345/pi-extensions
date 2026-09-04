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

export type NativeCheckpoint = {
	entryIndex: number;
	entryId: string;
	details: NativeCompactionDetails;
};

export type CheckpointLookup =
	| { status: "none" }
	| { status: "invalid"; entryIndex: number; entryId: string }
	| { status: "valid"; checkpoint: NativeCheckpoint };

export function isOpenAICodexModel(model: unknown): model is Model<"openai-codex-responses"> {
	if (!isJsonObject(model)) return false;
	return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function modelKey(model: Pick<Model<Api>, "provider" | "api" | "id">): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

export function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isJsonObject(value)) return undefined;
	if (value.kind !== NATIVE_COMPACTION_KIND || value.version !== NATIVE_COMPACTION_VERSION) return undefined;
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

export function findNativeCheckpoint(branch: SessionEntry[]): CheckpointLookup {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;

		let rawDetails: unknown;
		if (entry.type === "compaction") {
			if (!isJsonObject(entry.details) || entry.details.kind !== NATIVE_COMPACTION_KIND) {
				return { status: "none" };
			}
			rawDetails = entry.details;
		} else if (entry.type === "custom" && entry.customType === NATIVE_COMPACTION_KIND) {
			rawDetails = entry.data;
		} else {
			continue;
		}

		const details = parseNativeCompactionDetails(rawDetails);
		if (!details) return { status: "invalid", entryIndex: index, entryId: entry.id };
		return {
			status: "valid",
			checkpoint: { entryIndex: index, entryId: entry.id, details },
		};
	}
	return { status: "none" };
}
