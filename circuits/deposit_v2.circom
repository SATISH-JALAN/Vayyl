pragma circom 2.1.0;

include "lib/note.circom";
include "asp_membership.circom";

// Vault V2 deposit: every note is exactly 1 XLM (10,000,000 stroops).
// The note public key is derived from privKey inside the circuit.
template DepositV2(depth) {
    signal input commitment;
    signal input asp_root;

    signal input privKey;
    signal input blindness;
    signal input asp_pathElements[depth];
    signal input asp_pathIndices[depth];

    component note = Note();
    note.privKey <== privKey;
    note.amount <== 10000000;
    note.blindness <== blindness;
    note.commitment === commitment;

    component asp = ASPMembership(depth);
    asp.pubX <== note.pubX;
    asp.pubY <== note.pubY;
    for (var i = 0; i < depth; i++) {
        asp.pathElements[i] <== asp_pathElements[i];
        asp.pathIndices[i] <== asp_pathIndices[i];
    }
    asp.root === asp_root;
}

component main { public [commitment, asp_root] } = DepositV2(20);
