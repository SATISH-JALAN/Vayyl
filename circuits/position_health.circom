pragma circom 2.1.0;

include "lib/position_primitives.circom";
include "lib/range_check.circom";

// Position Health Attestation Circuit
// Evaluates the solvency of a confidential position against a public oracle price.
//
// Security: oracle_timestamp is a public input bound to the proof via a
// squaring constraint. The on-chain contract supplies the real timestamp
// from the oracle, so the prover cannot forge a stale or future price.
template PositionHealth() {
    // Public Inputs
    signal input position_commitment;
    signal input oracle_price;
    signal input oracle_timestamp; // Bound directly as public input

    // Private Inputs
    signal input collateral_amount;
    signal input size;
    signal input direction; // 0 for Short, 1 for Long
    signal input entry_price;
    signal input pubX;
    signal input pubY;
    signal input position_blindness;

    // 1. Bind oracle_timestamp to the proof (prevent freely-chosen timestamp)
    signal oracle_ts_sq <== oracle_timestamp * oracle_timestamp;

    // 2. Validate Position Commitment
    component pos_commit = PositionCommitment();
    pos_commit.collateral_amount <== collateral_amount;
    pos_commit.size <== size;
    pos_commit.direction <== direction;
    pos_commit.entry_price <== entry_price;
    pos_commit.pubX <== pubX;
    pos_commit.pubY <== pubY;
    pos_commit.blindness <== position_blindness;

    pos_commit.commitment === position_commitment;

    // 3. Validate boolean direction
    direction * (direction - 1) === 0;

    // 4. Compute PnL and Solvency Inequality
    // Long is solvent if:  collateral + size * oracle_price >= size * entry_price
    // Short is solvent if: collateral + size * entry_price >= size * oracle_price
    //
    // Unified via selector:
    //   asset_val = direction * (oracle_price - entry_price) + entry_price
    //   debt_val  = direction * (entry_price - oracle_price) + oracle_price
    //
    // For Long (direction=1): asset_val = oracle_price, debt_val = entry_price
    // For Short (direction=0): asset_val = entry_price, debt_val = oracle_price
    
    signal price_diff <== oracle_price - entry_price;
    
    signal asset_val;
    asset_val <== direction * price_diff + entry_price;

    signal neg_price_diff <== entry_price - oracle_price;
    
    signal debt_val;
    debt_val <== direction * neg_price_diff + oracle_price;

    signal size_times_asset <== size * asset_val;
    signal lhs;
    lhs <== collateral_amount + size_times_asset;

    signal size_times_debt <== size * debt_val;

    // 5. Assert Solvency (128-bit comparison to avoid overflow when multiplying size * price)
    component solvency_check = AssertGreaterEqThan(128);
    solvency_check.a <== lhs;
    solvency_check.b <== size_times_debt;
}

component main { public [ position_commitment, oracle_price, oracle_timestamp ] } = PositionHealth();
