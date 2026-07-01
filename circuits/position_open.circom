pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";
include "lib/range_check.circom";
include "lib/position_primitives.circom";
include "lib/babyjubjub.circom";

// Position Open Circuit
// Consumes a shielded note as collateral and opens a confidential derivative position.
template PositionOpen(depth) {
    // Public Inputs
    signal input root;
    signal input nullifier;
    signal input position_commitment;
    signal input meta_hash;

    // Private Inputs (Collateral Note)
    signal input amount;
    signal input pubX;
    signal input pubY;
    signal input blindness;
    signal input privKey;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Private Inputs (Position Parameters)
    signal input size;
    signal input direction; // 0 for Short, 1 for Long
    signal input entry_price;
    signal input position_blindness;

    // 1. Dummy constraint for meta_hash
    signal meta_hash_sq <== meta_hash * meta_hash;
    
    // 2. Validate Public Key derivation
    component pubKeyDerivation = DerivePublicKey();
    pubKeyDerivation.privKey <== privKey;
    pubKeyDerivation.pubX === pubX;
    pubKeyDerivation.pubY === pubY;

    // 3. Note Commitment & Nullifier
    component note = NoteCommitment();
    note.amount <== amount;
    note.pubX <== pubX;
    note.pubY <== pubY;
    note.blindness <== blindness;

    component note_nullifier = NoteNullifier();
    note_nullifier.commitment <== note.commitment;
    note_nullifier.privKey <== privKey;
    note_nullifier.nullifier === nullifier;

    // 4. Merkle Inclusion
    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // 5. Direction Boolean Constraint
    direction * (direction - 1) === 0;

    // 6. Generate Position Commitment
    component pos_commit = PositionCommitment();
    pos_commit.collateral_amount <== amount;
    pos_commit.size <== size;
    pos_commit.direction <== direction;
    pos_commit.entry_price <== entry_price;
    pos_commit.pubX <== pubX;
    pos_commit.pubY <== pubY;
    pos_commit.blindness <== position_blindness;

    pos_commit.commitment === position_commitment;
}

component main { public [ root, nullifier, position_commitment, meta_hash ] } = PositionOpen(20);
