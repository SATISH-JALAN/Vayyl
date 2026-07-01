pragma circom 2.1.0;

include "poseidon2.circom";
include "merkle.circom";

// Position Commitment
// Binds collateral, size, direction, entry_price, and ownership (pubX, pubY)
template PositionCommitment() {
    signal input collateral_amount;
    signal input size;
    signal input direction;
    signal input entry_price;
    signal input pubX;
    signal input pubY;
    signal input blindness;

    signal output commitment;

    // 1. Compress position details
    component meta_hasher = Poseidon2Hash_4();
    meta_hasher.in[0] <== size;
    meta_hasher.in[1] <== direction;
    meta_hasher.in[2] <== entry_price;
    meta_hasher.in[3] <== blindness;

    // 2. Main commitment
    component pos_hasher = Poseidon2Hash_4();
    pos_hasher.in[0] <== collateral_amount;
    pos_hasher.in[1] <== pubX;
    pos_hasher.in[2] <== pubY;
    pos_hasher.in[3] <== meta_hasher.out;

    commitment <== pos_hasher.out;
}

// Position Nullifier
// Prevents double-spending of a position
template PositionNullifier() {
    signal input commitment;
    signal input privKey;
    signal output nullifier;

    component hasher = Poseidon2Hash_2();
    hasher.in[0] <== commitment;
    hasher.in[1] <== privKey;

    nullifier <== hasher.out;
}
