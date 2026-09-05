pragma circom 2.1.0;

// Position tier constants
// =======================
// A position's collateral and size are PUBLIC constants selected by `tier_id`,
// not free witnesses. Deriving them here rather than accepting them as private
// inputs is what closes audit P2: a prover who could name their own collateral
// or size could open a position whose margin the vault never reserved for.
//
// THESE VALUES ARE MIRRORED IN THREE PLACES and must be identical in all of
// them:
//
//   contracts/vayyl-types/src/lib.rs   TIER_MARGIN / TIER_SIZE / TIER_MAX_PAYOUT
//   circuits/lib/tiers.circom          this file
//   frontend/src/dapp/lib/tiers.ts     TIERS
//
// A mismatch does not error anywhere. The contract builds a public input from
// its table, the circuit constrains against its own, and the pairing check
// simply fails — on-chain, after the user has paid for a proof, with nothing in
// the failure pointing at the cause. `scripts/check_tier_sync.js` compares all
// three and is wired into the frontend test run so a drift fails CI instead.
//
// Why a linear interpolation instead of a lookup: with two tiers, `tier_id` is
// a bit, and `a + tier_id * (b - a)` is exact and costs one constraint. A
// lookup table would need a full selector per entry. If a third tier is ever
// added this template must become a proper one-hot selector — the boolean
// constraint below is what makes that impossible to forget, because a
// `tier_id` of 2 will simply fail to prove.

template TierConstants() {
    signal input tier_id;

    signal output margin;      // collateral required, in stroops
    signal output size;        // position size, in contract units
    signal output max_payout;  // the knock-out cap, in stroops

    // Exactly two tiers. This is the constraint that pins `tier_id` to a value
    // the interpolation below is valid for; without it a `tier_id` of, say, 5
    // would produce a margin of 2,100,000,000 that appears in no table on
    // either side of the chain.
    tier_id * (tier_id - 1) === 0;

    margin     <== 100000000  + tier_id * (500000000  - 100000000);
    size       <== 30         + tier_id * (150        - 30);
    max_payout <== 300000000  + tier_id * (1500000000 - 300000000);
}
