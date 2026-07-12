pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";

// Vault V2 withdrawal: the pool amount is implicit and the public binding is
// computed from the recipient plus the fixed denomination by the contract.
template WithdrawV2(depth) {
    signal input root;
    signal input nullifier;
    signal input withdraw_binding;

    signal input privKey;
    signal input blindness;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Keep the recipient binding in the public Groth16 statement.
    signal withdraw_binding_sq <== withdraw_binding * withdraw_binding;

    component note = Note();
    note.privKey <== privKey;
    note.amount <== 10000000;
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

component main { public [root, nullifier, withdraw_binding] } = WithdrawV2(20);
