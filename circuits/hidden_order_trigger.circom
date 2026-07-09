pragma circom 2.1.0;

include "lib/poseidon2.circom";
include "lib/range_check.circom";

// HiddenOrderTrigger Circuit (system design §2.9)
// =============================================
// Proves a committed order's trigger condition IS met against a public oracle
// price, without revealing the trigger price or direction until execution. A
// keeper can only execute the order once the price has actually crossed the
// trigger — a premature attempt simply has no satisfiable witness.
//
//   order_commitment = Poseidon2(trigger_price, order_direction, salt)
//   order_direction ∈ {0,1}
//   trigger fired:
//     direction = 1 → fires when oracle_price >= trigger_price   (up side)
//     direction = 0 → fires when oracle_price <= trigger_price   (down side)
//
// Selector-via-range-check (§2.9 discipline): the fired-side "gap" is range-
// checked to [0, 2^64). If the trigger has NOT fired, the gap is field-negative
// (~254 bits) and the range check fails — there is no proof, so the order cannot
// be executed early. Never trust `order_direction` as a free boolean alone.
//
// `meta_hash` binds the settlement's recipient + fee into the proof (computed
// on-chain), so a copied proof can't be re-pointed at a different payout — the
// front-running defense the design mandates for every economically-consequential
// circuit.
template HiddenOrderTrigger() {
    // Public
    signal input order_commitment;
    signal input oracle_price;
    signal input meta_hash;

    // Private
    signal input trigger_price;
    signal input order_direction; // 1 = fire on price >= trigger, 0 = fire on price <= trigger
    signal input salt;

    // Bind meta_hash (recipient/fee) to the proof.
    signal meta_sq <== meta_hash * meta_hash;

    // Range-check the magnitudes entering the trigger comparison.
    component rc_trigger = RangeCheck64();
    rc_trigger.in <== trigger_price;
    component rc_oracle = RangeCheck64();
    rc_oracle.in <== oracle_price;

    // Commitment binding — the prover must know the order's opening.
    component commit = Poseidon2Hash_3();
    commit.in[0] <== trigger_price;
    commit.in[1] <== order_direction;
    commit.in[2] <== salt;
    commit.out === order_commitment;

    // Boolean direction.
    order_direction * (order_direction - 1) === 0;

    // Trigger inequality via selector-on-the-selected-value.
    //   gap = order_direction·(oracle - trigger) + (1 - order_direction)·(trigger - oracle)
    //       = order_direction·((oracle-trigger) - (trigger-oracle)) + (trigger-oracle)
    signal up   <== oracle_price - trigger_price;
    signal down <== trigger_price - oracle_price;
    signal sel_span <== order_direction * (up - down);
    signal gap <== sel_span + down;
    // gap >= 0 iff the correct-direction trigger has fired. Both prices are
    // < 2^64, so the fired-side gap is < 2^64 and fits; the wrong side wraps.
    component rc_gap = RangeCheckN(65);
    rc_gap.in <== gap;
}

component main { public [ order_commitment, oracle_price, meta_hash ] } = HiddenOrderTrigger();
