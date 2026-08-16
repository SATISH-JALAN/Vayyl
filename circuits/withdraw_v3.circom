pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";

// Vault V3 withdraw: arbitrary amount.
// ====================================
// WithdrawV2 hard-coded `note.amount <== 10000000`, so every exit was exactly
// 1 XLM regardless of what the note was worth.
//
// `amount` is PUBLIC, and it has to be. The pool pays this many stroops to a
// named account, so the value is on the ledger either way. More importantly it
// must sit in the proof statement: if the amount were only a private input, the
// circuit would prove "some note exists" while the contract independently paid
// out whatever amount the caller asked for, and a 1 XLM note would authorize a
// 100 XLM withdrawal. The contract uses this same value for both the payout and
// the binding below, and the constraint here ties it to the note being spent.
//
// Public: [root, nullifier, amount, withdraw_binding]
template WithdrawV3(depth) {
    signal input root;
    signal input nullifier;
    signal input amount;
    signal input withdraw_binding;

    signal input privKey;
    signal input blindness;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Keep the recipient binding in the public Groth16 statement. Without a
    // constraint referencing it, circom drops the unused signal and the
    // verification key stops binding it, leaving the payout address free for
    // anyone relaying the proof to rewrite.
    signal withdraw_binding_sq <== withdraw_binding * withdraw_binding;

    // Note() re-derives the public key from privKey and range-checks `amount`
    // to 64 bits, so the value leaving the pool cannot exceed what the note
    // legitimately holds.
    component note = Note();
    note.privKey <== privKey;
    note.amount <== amount;
    note.blindness <== blindness;
    note.nullifier === nullifier;

    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;
}

component main { public [root, nullifier, amount, withdraw_binding] } = WithdrawV3(20);
