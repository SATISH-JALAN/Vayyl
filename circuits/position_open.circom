pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";
include "lib/range_check.circom";
include "lib/position_primitives.circom";
include "lib/tiers.circom";

// Position Open
// =============
// Spends one shielded note and opens a tiered directional position, returning
// the unused part of the note as change.
//
// Public: [root, nullifier, position_commitment, change_commitment,
//          tier_id, entry_price, direction, position_id]
//
// What changed from the previous version, and why each one mattered
// -----------------------------------------------------------------
//
// 1. `pubX`/`pubY` were FREE WITNESSES with the derivation commented out
//    ("BabyJubJub binding is deferred to Sprint 7"). A prover could therefore
//    name any public key, so the note whose membership they proved need not
//    have been theirs — the Merkle proof establishes that a note EXISTS, and
//    the key is what establishes whose it is. `Note()` now derives the key from
//    `privKey` on the curve, which is audit F1 applied here: one note, one
//    nullifier, one owner.
//
// 2. `entry_price` was a free witness. A trader could open at any price they
//    liked, including one that guaranteed a profit — the position's entire PnL
//    is measured from it (audit P0). It is now a PUBLIC input the contract
//    fills from the oracle, under a staleness check.
//
// 3. `amount` and `size` were free witnesses. Both now come from the tier
//    table, so collateral and size are exactly what the counterparty vault
//    reserved against (audit P2).
//
// 4. The collateral note used to be consumed WHOLE with no change output, so
//    only a note of exactly the tier margin could open a position. That is not
//    a limitation a user can work around: notes arrive at whatever size a
//    deposit or a payment made them.
//
// 5. `meta_hash` was an input the circuit only squared — a value that looked
//    like a binding and bound nothing. It is replaced by `position_id`, which
//    the CONTRACT supplies from the id it is about to store. That makes the
//    proof non-transferable between positions: a proof produced for one
//    position id verifies for no other.
template PositionOpen(depth) {
    // ── public ────────────────────────────────────────────────
    signal input root;
    signal input nullifier;            // of the collateral note being spent
    signal input position_commitment;
    signal input change_commitment;    // the remainder of the collateral note
    signal input tier_id;
    signal input entry_price;          // the oracle's price, supplied on-chain
    signal input direction;            // 1 = long, 0 = short
    signal input position_id;

    // ── private ───────────────────────────────────────────────
    signal input privKey;
    signal input in_amount;            // the whole collateral note
    signal input in_blindness;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input change_amount;
    signal input change_blindness;
    signal input position_blindness;

    // ── tier constants ────────────────────────────────────────
    component tier = TierConstants();
    tier.tier_id <== tier_id;

    // ── direction is a bit ────────────────────────────────────
    // It selects the sign of every future PnL calculation. Left as an arbitrary
    // field element, the settled value becomes attacker-chosen.
    direction * (direction - 1) === 0;

    // ── the collateral note ───────────────────────────────────
    // Note() derives (pubX, pubY) from privKey, constrains the scalar to
    // [1, l) — so one note yields exactly one nullifier — and range-checks
    // in_amount to 64 bits, which is what keeps the conservation equation
    // below from wrapping the field.
    component note = Note();
    note.privKey <== privKey;
    note.amount <== in_amount;
    note.blindness <== in_blindness;
    note.nullifier === nullifier;

    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // ── conservation ──────────────────────────────────────────
    // The note pays the margin and nothing else; whatever is left comes back as
    // change. `change_amount` is range-checked BEFORE the equation, so it
    // cannot be a huge field element that makes the sum wrap — and because it
    // is non-negative, the equation also proves `in_amount >= margin` without a
    // separate comparator.
    component rc_change = RangeCheck64();
    rc_change.in <== change_amount;

    in_amount === tier.margin + change_amount;

    // Change returns to the SAME key that owned the input, so the wallet can
    // find it: blindness is derived client-side from (privKey, position_id),
    // which is reproducible on a clean device from public event data plus the
    // spend key. See frontend/src/dapp/lib/position-notes.ts.
    component change_note = NoteCommitment();
    change_note.amount <== change_amount;
    change_note.pubX <== note.pubX;
    change_note.pubY <== note.pubY;
    change_note.blindness <== change_blindness;
    change_note.commitment === change_commitment;

    // ── the position ──────────────────────────────────────────
    // entry_price feeds a multiplication in position_health and in the
    // contract's settlement, so it is bounded here at the moment it is
    // committed rather than only where it is used.
    component rc_entry = RangeCheck64();
    rc_entry.in <== entry_price;

    component pos = PositionCommitment();
    pos.collateral_amount <== tier.margin;
    pos.size <== tier.size;
    pos.direction <== direction;
    pos.entry_price <== entry_price;
    pos.pubX <== note.pubX;
    pos.pubY <== note.pubY;
    pos.blindness <== position_blindness;
    pos.commitment === position_commitment;

    // ── bind the position id ──────────────────────────────────
    // An unconstrained public signal can be optimised out of the R1CS entirely,
    // which would leave it absent from the statement and therefore free to
    // change. Squaring keeps it in.
    signal position_id_sq <== position_id * position_id;
}

component main {
    public [
        root,
        nullifier,
        position_commitment,
        change_commitment,
        tier_id,
        entry_price,
        direction,
        position_id
    ]
} = PositionOpen(20);
