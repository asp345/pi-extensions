export {
	_lineHashesPure,
	ANCHOR_LEN,
	CANON_VERSION,
	canon,
	defaultHashIdentity,
	HASH_CLASS,
	HASH_LEN,
	HASH_SEP,
	HASH_SPACE,
	HashIdentity,
	type HashOptions,
	type HashPrior,
	type HashSnapshotIO,
	HL_BARE_PREFIX_RE,
	HL_PREFIX_MINUS_RE,
	HL_PREFIX_PLUS_RE,
	initHasher,
	isValidHashList,
	lineHashes,
	MAX_HASH_LINES,
} from "./hash-identity.ts";

export const HASH_PROBE_STRIDE = 3907;

export {
	applyEdit,
	buildIdx,
	changedRange,
	fmtRegion,
} from "./apply.ts";
export {
	type Anchor,
	parseHashRef,
	parseText,
} from "./parse.ts";
export {
	type AutoFix,
	type BDup,
	findNewEdge,
	fmtMismatch,
	type HEdit,
	type HTEdit,
	type NEdit,
	type RAnchor,
	type RHEdit,
	resEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	valEdit,
} from "./resolve.ts";
