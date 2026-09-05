pragma circom 2.1.0;

include "lib/note.circom";
include "lib/range_check.circom";
include "lib/position_primitives.circom";
include "lib/tiers.circom";
include "lib/babyjubjub.circom";

// Position Close
// ==============
// Proves ownership of an open position and mints the settled payout as a
// shielded note.
//
// Public: [position_nullifier, output_note_commitment, old_position_commitment,
//          tier_id, entry_price, direction, payout, fee, position_id]
//
// The settlement arithmetic moved on-chain
// ----------------------------------------
// The previous circuit computed PnL itself, from a balance equation over free
// witnesses:
//
//     old_collateral + old_size*asset_val === new_collateral + note_amount
//                                            + fee + old_size*debt_val
//
// with `old_collateral`, `old_size`, `old_entry_price`, `old_pubX/Y` and
// `old_privKey` all unconstrained, and the OLD COMMITMENT not a public input at
// all. So a prover could invent a position with whatever collateral, size and
// entry price produced the payout they wanted, and settle it (audit C3 plus the
// P0/P2/P3 cluster). Every constraint in that equation was satisfiable by
// construction because the prover chose both sides.
//
// Now `payout` is a PUBLIC input the contract computes from stored state and a
// fresh oracle price. This circuit does not re-derive it; it proves the two
// things a contract cannot:
//
//   1. The prover owns the position — they know the spend key whose BabyJubjub
//      public key opens `old_position_commitment` (audit P3/P7). The old
//      commitment is supplied by the CONTRACT from `PositionState`, so there is
//      no position to invent (audit C3).
//   2. The output note is worth exactly `payout - fee` and is addressed to that
//      same key, so the settled value cannot be redirected or inflated.
//
// `new_position_commitment` is gone with the modify path: a tier fixes the size,
// so a partially closed position would belong to no tier, and an untiered
// position is one the vault cannot reserve against.
template PositionClose() {
    // ── public ────────────────────────────────────────────────
    signal input position_nullifier;
    signal input output_note_commitment;
    signal input old_position_commitment;  // from PositionState, not the caller
    signal input tier_id;
    signal input entry_price;
    signal input direction;
    signal input payout;                   // computed on-chain, capped
    signal input fee;
    signal input position_id;

    // ── private ───────────────────────────────────────────────
    signal input privKey;
    signal input position_blindness;
    signal input note_blindness;

    component tier = TierConstants();
    tier.tier_id <== tier_id;

    direction * (direction - 1) === 0;

    // ── ownership ─────────────────────────────────────────────
    // The public key is DERIVED, never witnessed. As a free witness a prover
    // could claim a position addressed to a key they do not hold; the
    // commitment check alone does not stop that, because the commitment is
    // being reconstructed from the same free values.
    component key = DerivePublicKey();
    key.privKey <== privKey;

    component pos = PositionCommitment();
    pos.collateral_amount <== tier.margin;
    pos.size <== tier.size;
    pos.direction <== direction;
    pos.entry_price <== entry_price;
    pos.pubX <== key.pubX;
    pos.pubY <== key.pubY;
    pos.blindness <== position_blindness;
    pos.commitment === old_position_commitment;

    component nf = PositionNullifier();
    nf.commitment <== pos.commitment;
    nf.privKey <== privKey;
    nf.nullifier === position_nullifier;

    // ── the payout ────────────────────────────────────────────
    component rc_payout = RangeCheck64();
    rc_payout.in <== payout;

    component rc_fee = RangeCheck64();
    rc_fee.in <== fee;

    // The note is the payout net of the relayer fee. Range-checking the
    // DIFFERENCE is what enforces `fee <= payout`: a larger fee makes this
    // p - k, a ~254-bit value that cannot decompose into 64 bits. No separate
    // comparator is needed, and there is no way to reach a negative note.
    signal note_amount <== payout - fee;
    component rc_note = RangeCheck64();
    rc_note.in <== note_amount;

    component out = NoteCommitment();
    out.amount <== note_amount;
    out.pubX <== key.pubX;
    out.pubY <== key.pubY;
    out.blindness <== note_blindness;
    out.commitment === output_note_commitment;

    // ── the solvency cap ──────────────────────────────────────
    // The contract already clamps `payout` to the tier maximum. Re-asserting it
    // here means the two would have to be wrong in the SAME direction for the
    // vault's reservation to be insufficient — and the reservation is the only
    // thing standing between a winning trader and an unpayable claim. Both
    // values are below 2^64, so 65 bits is enough for the comparator.
    component cap = AssertGreaterEqThan(65);
    cap.a <== tier.max_payout;
    cap.b <== payout;

    // Keeps the id in the statement — see position_open.circom.
    signal position_id_sq <== position_id * position_id;
}

component main {
    public [
        position_nullifier,
        output_note_commitment,
        old_position_commitment,
        tier_id,
        entry_price,
        direction,
        payout,
        fee,
        position_id
    ]
} = PositionClose();
