pragma circom 2.1.0;

include "lib/position_primitives.circom";
include "lib/range_check.circom";

// Position Health Attestation Circuit
// Evaluates the solvency of a confidential position against a public oracle price.
template PositionHealth(depth) {
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

    // 1. Validate Position Commitment
    component pos_commit = PositionCommitment();
    pos_commit.collateral_amount <== collateral_amount;
    pos_commit.size <== size;
    pos_commit.direction <== direction;
    pos_commit.entry_price <== entry_price;
    pos_commit.pubX <== pubX;
    pos_commit.pubY <== pubY;
    pos_commit.blindness <== position_blindness;

    pos_commit.commitment === position_commitment;

    // 2. Validate boolean direction
    direction * (direction - 1) === 0;

    // 3. Compute PnL and Solvency Inequality
    // Long is solvent if:  collateral + size * oracle_price >= size * entry_price
    // Short is solvent if: collateral + size * entry_price >= size * oracle_price
    
    signal asset_val;
    asset_val <== direction * (oracle_price - entry_price) + entry_price;

    signal debt_val;
    debt_val <== direction * (entry_price - oracle_price) + oracle_price;

    signal lhs;
    lhs <== collateral_amount + (size * asset_val);

    signal rhs;
    rhs <== size * debt_val;

    // 4. Assert Solvency (128-bit comparison to avoid overflow when multiplying size * price)
    component solvency_check = AssertGreaterEqThan(128);
    solvency_check.a <== lhs;
    solvency_check.b <== rhs;
}

component main { public [ position_commitment, oracle_price, oracle_timestamp ] } = PositionHealth(20);
