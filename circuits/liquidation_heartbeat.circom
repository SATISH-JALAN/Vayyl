pragma circom 2.1.0;

include "lib/position_primitives.circom";
include "lib/poseidon2.circom";

// Liquidation Heartbeat Circuit (Section 2.8)
//
// Proves that:
// 1. The prover knows the opening of a position commitment
// 2. The keeper is bound to a secret via keeper_public_commitment
// 3. The timestamp is bound to the proof (anti-replay)
//
// The on-chain LiquidationEngine uses this to verify that the keeper
// who initiated liquidation actually knows the position details and
// has committed to a secret that can be revealed later to claim collateral.
template LiquidationHeartbeat() {
    // Public Inputs
    signal input position_commitment;
    signal input keeper_public_commitment;
    signal input timestamp;

    // Private Inputs (Position)
    signal input collateral_amount;
    signal input size;
    signal input direction; // 0 for Short, 1 for Long
    signal input entry_price;
    signal input pubX;
    signal input pubY;
    signal input position_blindness;

    // Private Input (Keeper)
    signal input keeper_secret;

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

    // 2. Direction boolean constraint
    direction * (direction - 1) === 0;

    // 3. Keeper Public Commitment
    // keeper_public_commitment ≡ Poseidon2(keeper_secret)
    // This binds the keeper to their secret — they must reveal it later
    // to claim the liquidated collateral via reveal_and_seize().
    component keeper_hasher = Poseidon2Hash_2();
    keeper_hasher.in[0] <== keeper_secret;
    keeper_hasher.in[1] <== 0; // Domain separator — matches on-chain poseidon2_hash([secret, 0])

    keeper_hasher.out === keeper_public_commitment;

    // 4. Bind timestamp to the proof (anti-replay)
    // The on-chain contract supplies the real timestamp from the ledger,
    // so the prover cannot forge a stale or future timestamp.
    signal ts_sq <== timestamp * timestamp;
}

component main { public [ position_commitment, keeper_public_commitment, timestamp ] } = LiquidationHeartbeat();
