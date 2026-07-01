pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";
include "lib/range_check.circom";

// Withdraw Circuit
// Consumes a single shielded note entirely and reveals its nullifier.
// Withdraws a public amount (plus fee) to the outside world.
template Withdraw(depth) {
    // Public Inputs
    signal input root;
    signal input nullifier;
    signal input public_amount;
    signal input fee;
    signal input withdraw_binding; // Binds the recipient address and other metadata

    // Private Inputs
    signal input amount;
    signal input pubX;
    signal input pubY;
    signal input blindness;
    signal input privKey;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // 1. Dummy constraint for withdraw binding
    signal withdraw_binding_sq <== withdraw_binding * withdraw_binding;

    // 2. Note Commitment & Nullifier
    component note = NoteCommitment();
    note.amount <== amount;
    note.pubX <== pubX;
    note.pubY <== pubY;
    note.blindness <== blindness;

    component note_nullifier = NoteNullifier();
    note_nullifier.commitment <== note.commitment;
    note_nullifier.privKey <== privKey;
    note_nullifier.nullifier === nullifier;

    // 3. Merkle Inclusion
    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // 4. Balance check (entire note is consumed)
    component amount_check = Num2Bits(64);
    amount_check.in <== public_amount;

    component fee_check = Num2Bits(64);
    fee_check.in <== fee;

    amount === public_amount + fee;
}

component main { public [ root, nullifier, public_amount, fee, withdraw_binding ] } = Withdraw(20);
