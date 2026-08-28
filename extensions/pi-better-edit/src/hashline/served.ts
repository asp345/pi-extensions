/**
 * served — thin facade over ServedVerification deep module.
 *
 * All verification logic lives in served-verification.ts (instance-scoped CanonStore,
 * decision-table branching, orphan healing, echo building). This file re-exports the
 * public surface so existing importers (`from "./served.ts"`) remain stable and so
 * ServedRejectionError identity is singular (defined in served-verification).
 */

// Re-export CanonStore adapters so callers can inject an isolated store
// without importing hash directly — keeps served boundary self-contained.
export {
	__clearGlobalCanonStoreForTest,
	__globalCanonEntriesForTest,
	type CanonStore,
	createCanonStore,
	createCanonStoreFromEntries,
	globalCanonStore,
} from "./hash.ts";
export {
	AnchorMismatchError,
	buildRangeEcho,
	fmtServedRows,
	isAnchorMismatch,
	isServedRejection,
	type ResolvedRange,
	type ServedCode,
	ServedRejectionError,
	type ServedRow,
	ServedVerification,
	servedPositionsOf,
	type VerificationInput,
	type VerificationRange,
	type VerificationResult,
	verifyServedRange,
	verifyServedRangeResult,
} from "./served-verification.ts";
