pragma circom 2.1.0;

// Core Note Primitive
// ====================
// The fundamental building block for all Vayyl circuits.
//
// commitment ≡ Poseidon2(amount, pub_x, pub_y, blindness)
// nullifier  ≡ Poseidon2(commitment, priv_key)
//
// Used by: Deposit, Transfer, Withdraw, PositionOpen, PositionClose

include "poseidon2.circom";
include "babyjubjub.circom";
include "range_check.circom";

// ─────────────────────────────────────────────────────────────
// NoteCommitment: compute commitment from note components
// ─────────────────────────────────────────────────────────────
// commitment = Poseidon2Hash(4)(amount, pub_x, pub_y, blindness)
// This is a 4-input hash using t=4, which requires 2 sponge blocks:
//   Block 1: absorb [amount, pub_x, pub_y] → permute
//   Block 2: absorb [blindness] → permute → squeeze
template NoteCommitment() {
    signal input amount;
    signal input pubX;
    signal input pubY;
    signal input blindness;
    signal output commitment;

    component hash = Poseidon2Hash_4();
    hash.in[0] <== amount;
    hash.in[1] <== pubX;
    hash.in[2] <== pubY;
    hash.in[3] <== blindness;

    commitment <== hash.out;
}

// ─────────────────────────────────────────────────────────────
// NoteNullifier: compute nullifier from commitment and private key
// ─────────────────────────────────────────────────────────────
// nullifier = Poseidon2Hash(2)(commitment, priv_key)
// This is a 2-input hash using t=3.
template NoteNullifier() {
    signal input commitment;
    signal input privKey;
    signal output nullifier;

    component hash = Poseidon2Hash_2();
    hash.in[0] <== commitment;
    hash.in[1] <== privKey;

    nullifier <== hash.out;
}

// ─────────────────────────────────────────────────────────────
// Note: Full note primitive — derives public key, computes
// commitment and nullifier.
// ─────────────────────────────────────────────────────────────
// Given a private key, amount, and blindness:
// 1. Derive (pub_x, pub_y) from priv_key
// 2. Compute commitment = Poseidon2(amount, pub_x, pub_y, blindness)
// 3. Compute nullifier = Poseidon2(commitment, priv_key)
// 4. Range check amount to 64 bits
template Note() {
    signal input privKey;
    signal input amount;
    signal input blindness;

    signal output pubX;
    signal output pubY;
    signal output commitment;
    signal output nullifier;

    // 1. Derive public key
    component deriveKey = DerivePublicKey();
    deriveKey.privKey <== privKey;
    pubX <== deriveKey.pubX;
    pubY <== deriveKey.pubY;

    // 2. Compute commitment
    component noteCommitment = NoteCommitment();
    noteCommitment.amount <== amount;
    noteCommitment.pubX <== deriveKey.pubX;
    noteCommitment.pubY <== deriveKey.pubY;
    noteCommitment.blindness <== blindness;
    commitment <== noteCommitment.commitment;

    // 3. Compute nullifier
    component noteNullifier = NoteNullifier();
    noteNullifier.commitment <== noteCommitment.commitment;
    noteNullifier.privKey <== privKey;
    nullifier <== noteNullifier.nullifier;

    // 4. Range check amount (64-bit)
    component rc = RangeCheck64();
    rc.in <== amount;
}
