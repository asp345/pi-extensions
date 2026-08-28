import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-bun";

export const SCAN_TIMEOUT_MS = 15_000;

/** Load and retain the Bun SDK across Pi extension reloads. */
export type FileFinderStatic = {
	create(options: InitOptions): Result<FileFinderApi>;
};

let sdkPromise: Promise<{ FileFinder: FileFinderStatic }> | null = null;

export function loadSdk(): Promise<{ FileFinder: FileFinderStatic }> {
	if (sdkPromise) return sdkPromise;

	// Pi reloads extension modules with jiti moduleCache:false, so this module
	// is re-executed on every /reload. Re-importing the fff-bun module graph
	// (which top-level awaits a `type: "file"` import of the native .so) hangs
	// forever inside the Bun-compiled pi binary. Cache the first import on
	// globalThis so reloads reuse the resolved module instead of re-importing.
	const g = globalThis as Record<string, unknown>;
	if (g.__fffSdkPromiseGlobal) {
		sdkPromise = g.__fffSdkPromiseGlobal as Promise<{ FileFinder: FileFinderStatic }>;
		return sdkPromise;
	}

	const p = import("@ff-labs/fff-bun") as Promise<{ FileFinder: FileFinderStatic }>;
	sdkPromise = p;
	(globalThis as Record<string, unknown>).__fffSdkPromiseGlobal = p;
	return p;
}
