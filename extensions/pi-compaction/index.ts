import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCodexCompaction from "./codex.ts";
import registerTextCompaction from "./text.ts";

export default function compaction(pi: ExtensionAPI): void {
	registerTextCompaction(pi);
	registerCodexCompaction(pi);
}
