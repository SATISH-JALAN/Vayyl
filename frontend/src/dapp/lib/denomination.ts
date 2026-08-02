// The V2 pool is fixed-denomination: every note is exactly one unit, and the
// amount is a constant inside the circuits (`note.amount <== 10000000`) as well
// as on-chain (`V2_DENOMINATION`). Anything that validates or displays a note
// amount must agree with those, so it lives in one wallet-free module rather
// than as a literal repeated across storage, pool and transfer code.
//
// Changing this requires recompiling the circuits and redeploying — it is not a
// configuration value.

/** One shielded note, in stroops. Matches VayylPool::V2_DENOMINATION. */
export const V2_DENOMINATION_STROOPS = 10_000_000n;

/** The same amount in whole XLM, for display and note bookkeeping. */
export const V2_DENOMINATION_XLM = 1;
