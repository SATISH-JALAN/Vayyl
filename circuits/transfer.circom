pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";
include "lib/range_check.circom";

// Transfer Circuit
// 2-in / 2-out shielded transfer.
// Enforces balance conservation, nullifier derivation, and Merkle inclusion.
template Transfer(depth) {
    // Public Inputs
    signal input root;
    signal input nullifier1;
    signal input nullifier2;
    signal input commitment1;
    signal input commitment2;
    signal input fee;
    signal input meta_hash; // Binds the transaction (e.g. relayer address, fee) to the proof

    // Private Inputs - Input Note 1
    signal input in_amount1;
    signal input in_pubX1;
    signal input in_pubY1;
    signal input in_blindness1;
    signal input in_privKey1;
    signal input in_pathElements1[depth];
    signal input in_pathIndices1[depth];

    // Private Inputs - Input Note 2
    signal input in_amount2;
    signal input in_pubX2;
    signal input in_pubY2;
    signal input in_blindness2;
    signal input in_privKey2;
    signal input in_pathElements2[depth];
    signal input in_pathIndices2[depth];

    // Private Inputs - Output Note 1
    signal input out_amount1;
    signal input out_pubX1;
    signal input out_pubY1;
    signal input out_blindness1;

    // Private Inputs - Output Note 2
    signal input out_amount2;
    signal input out_pubX2;
    signal input out_pubY2;
    signal input out_blindness2;

    // 1. Dummy constraint to bind meta_hash to the proof
    signal meta_hash_sq <== meta_hash * meta_hash;

    // 2. Input 1 Logic
    component in1_note = NoteCommitment();
    in1_note.amount <== in_amount1;
    in1_note.pubX <== in_pubX1;
    in1_note.pubY <== in_pubY1;
    in1_note.blindness <== in_blindness1;

    component in1_nullifier = NoteNullifier();
    in1_nullifier.commitment <== in1_note.commitment;
    in1_nullifier.privKey <== in_privKey1;
    in1_nullifier.nullifier === nullifier1;

    component in1_tree = MerkleProof(depth);
    in1_tree.leaf <== in1_note.commitment;
    for (var i = 0; i < depth; i++) {
        in1_tree.pathElements[i] <== in_pathElements1[i];
        in1_tree.pathIndices[i] <== in_pathIndices1[i];
    }
    in1_tree.root === root;

    // 3. Input 2 Logic
    component in2_note = NoteCommitment();
    in2_note.amount <== in_amount2;
    in2_note.pubX <== in_pubX2;
    in2_note.pubY <== in_pubY2;
    in2_note.blindness <== in_blindness2;

    component in2_nullifier = NoteNullifier();
    in2_nullifier.commitment <== in2_note.commitment;
    in2_nullifier.privKey <== in_privKey2;
    in2_nullifier.nullifier === nullifier2;

    component in2_tree = MerkleProof(depth);
    in2_tree.leaf <== in2_note.commitment;
    for (var i = 0; i < depth; i++) {
        in2_tree.pathElements[i] <== in_pathElements2[i];
        in2_tree.pathIndices[i] <== in_pathIndices2[i];
    }
    in2_tree.root === root;

    // 3.5 Nullifier distinctness
    signal diff_inv <-- 1 / (nullifier1 - nullifier2);
    (nullifier1 - nullifier2) * diff_inv === 1;

    // 4. Output 1 Logic
    component out1_amount_check = Num2Bits(64);
    out1_amount_check.in <== out_amount1;

    component out1_note = NoteCommitment();
    out1_note.amount <== out_amount1;
    out1_note.pubX <== out_pubX1;
    out1_note.pubY <== out_pubY1;
    out1_note.blindness <== out_blindness1;
    out1_note.commitment === commitment1;

    // 5. Output 2 Logic
    component out2_amount_check = Num2Bits(64);
    out2_amount_check.in <== out_amount2;

    component out2_note = NoteCommitment();
    out2_note.amount <== out_amount2;
    out2_note.pubX <== out_pubX2;
    out2_note.pubY <== out_pubY2;
    out2_note.blindness <== out_blindness2;
    out2_note.commitment === commitment2;

    // 6. Balance Conservation
    component fee_check = Num2Bits(64);
    fee_check.in <== fee;

    in_amount1 + in_amount2 === out_amount1 + out_amount2 + fee;
}

component main { public [ root, nullifier1, nullifier2, commitment1, commitment2, fee, meta_hash ] } = Transfer(20);
