pragma circom 2.1.0;

include "lib/position_primitives.circom";
include "lib/range_check.circom";

// Position Health Attestation Circuit (system design §2.6)
// =======================================================
// Proves a confidential position is solvent WITH a maintenance margin against a
// public oracle price. If the owner cannot produce this proof (the position has
// fallen below the margin) their heartbeat goes stale and a keeper may liquidate
// — so the threshold IS the liquidation trigger, not decoration.
//
// Solvency, division-free (§2.6):
//   HEALTH_SCALE·(collateral + gain) >= HEALTH_SCALE·loss + size·oracle_price·health_threshold
// health_threshold is a PUBLIC maintenance-margin ratio in HEALTH_SCALE units
// (HEALTH_SCALE = 10000 → threshold 500 = 5% of notional required as equity).
// threshold = 0 reduces to bare break-even solvency.
//
// Two soundness properties this circuit enforces (audit H1):
//   1. Field-overflow: size/entry_price/oracle_price/collateral/threshold are
//      each range-checked to [0, 2^64) BEFORE any multiplication, so no product
//      can wrap mod p to forge a healthy position.
//   2. Selector-via-range-check: the price-vs-entry sign is a witnessed selector
//      (price_ge_entry) PINNED by a 65-bit range check on the SELECTED delta — a
//      wrong pick field-wraps to a ~254-bit value and fails. Never trust a bare
//      boolean witness for the sign.
template PositionHealth() {
    // Public Inputs
    signal input position_commitment;
    signal input oracle_price;
    signal input oracle_timestamp; // bound as public input (anti-stale / -future)
    signal input health_threshold; // maintenance-margin ratio, HEALTH_SCALE units

    // Private Inputs
    signal input collateral_amount;
    signal input size;
    signal input direction;        // 0 = short, 1 = long
    signal input entry_price;
    signal input pubX;
    signal input pubY;
    signal input position_blindness;
    signal input price_ge_entry;   // selector: 1 iff oracle_price >= entry_price

    var HEALTH_SCALE = 10000;

    // 1. Bind oracle_timestamp to the proof (prevent a freely-chosen timestamp).
    signal oracle_ts_sq <== oracle_timestamp * oracle_timestamp;

    // 1b. Range-check every base magnitude before it enters a multiplication.
    component rc_collateral = RangeCheck64();
    rc_collateral.in <== collateral_amount;
    component rc_size = RangeCheck64();
    rc_size.in <== size;
    component rc_entry = RangeCheck64();
    rc_entry.in <== entry_price;
    component rc_oracle = RangeCheck64();
    rc_oracle.in <== oracle_price;
    component rc_threshold = RangeCheck64();
    rc_threshold.in <== health_threshold;

    // 2. Validate the position commitment (binds the proof to a committed position).
    component pos_commit = PositionCommitment();
    pos_commit.collateral_amount <== collateral_amount;
    pos_commit.size <== size;
    pos_commit.direction <== direction;
    pos_commit.entry_price <== entry_price;
    pos_commit.pubX <== pubX;
    pos_commit.pubY <== pubY;
    pos_commit.blindness <== position_blindness;
    pos_commit.commitment === position_commitment;

    // 3. Booleans.
    direction * (direction - 1) === 0;
    price_ge_entry * (price_ge_entry - 1) === 0;

    // 4. Selector-via-range-check: pin price_ge_entry to the TRUE sign of
    //    (oracle_price - entry_price) by range-checking the selected delta.
    signal delta_up   <== oracle_price - entry_price;
    signal delta_down <== entry_price - oracle_price;
    // selected_delta = price_ge_entry·delta_up + (1-price_ge_entry)·delta_down
    //                = price_ge_entry·(delta_up - delta_down) + delta_down
    signal sel_span <== price_ge_entry * (delta_up - delta_down);
    signal selected_delta <== sel_span + delta_down;
    // Both prices are < 2^64, so the true non-negative delta is < 2^64 and fits
    // in 65 bits; the wrong selection yields p - delta (~254 bits) and fails.
    component rc_delta = RangeCheckN(65);
    rc_delta.in <== selected_delta;

    // 5. Split |PnL| = selected_delta·size into gain / loss.
    //    It is a gain iff the price moved in the position's favour, i.e. when
    //    price_ge_entry == direction (long+up or short+down); otherwise a loss.
    //    The magnitude is identical either way (selected_delta = |oracle-entry|).
    signal magnitude <== selected_delta * size;              // < 2^65 · 2^64 = 2^129
    signal pd <== price_ge_entry * direction;
    signal is_gain <== 1 - price_ge_entry - direction + 2*pd; // XNOR(price_ge_entry, direction)
    signal gain <== is_gain * magnitude;
    signal loss <== magnitude - gain;

    // 6. Division-free solvency with maintenance margin.
    //    lhs = HEALTH_SCALE·(collateral + gain)
    //    rhs = HEALTH_SCALE·loss + size·oracle_price·health_threshold
    signal lhs <== HEALTH_SCALE * (collateral_amount + gain);   // < 2^144
    signal notional <== size * oracle_price;                    // < 2^128
    signal margin <== notional * health_threshold;              // < 2^192
    signal rhs <== HEALTH_SCALE * loss + margin;                // < 2^193

    // Both sides < 2^193; size the comparator to 210 bits (§2.6 guidance).
    component solvency_check = AssertGreaterEqThan(210);
    solvency_check.a <== lhs;
    solvency_check.b <== rhs;
}

component main { public [ position_commitment, oracle_price, oracle_timestamp, health_threshold ] } = PositionHealth();
