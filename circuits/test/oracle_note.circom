pragma circom 2.1.0;

// Test-only oracle: recomputes the note commitment, nullifier, note-tree root,
// and ASP-tree root using the SAME library templates the real circuits use.
// A JS test reads these outputs to build a consistent VALID witness for
// deposit.circom / withdraw.circom (whose interior values must match on-chain).
// Never compiled into production — lives under circuits/test/.

include "../lib/note.circom";
include "../lib/merkle.circom";
include "../asp_membership.circom";

template OracleNote(depth) {
    signal input amount;
    signal input pubX;
    signal input pubY;
    signal input blindness;
    signal input privKey;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input asp_pathElements[depth];
    signal input asp_pathIndices[depth];

    signal output commitment;
    signal output nullifier;
    signal output root;      // note-tree Merkle root (used by withdraw)
    signal output asp_root;  // ASP-tree root (used by deposit)

    // commitment = Poseidon2(amount, pubX, pubY, blindness)
    component note = NoteCommitment();
    note.amount <== amount;
    note.pubX <== pubX;
    note.pubY <== pubY;
    note.blindness <== blindness;
    commitment <== note.commitment;

    // nullifier = Poseidon2(commitment, privKey)
    component nf = NoteNullifier();
    nf.commitment <== note.commitment;
    nf.privKey <== privKey;
    nullifier <== nf.nullifier;

    // note-tree root from leaf=commitment along the supplied path
    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    root <== tree.root;

    // ASP-tree root from leaf=Poseidon2(pubX,pubY) along the ASP path
    component asp = ASPMembership(depth);
    asp.pubX <== pubX;
    asp.pubY <== pubY;
    for (var i = 0; i < depth; i++) {
        asp.pathElements[i] <== asp_pathElements[i];
        asp.pathIndices[i] <== asp_pathIndices[i];
    }
    asp_root <== asp.root;
}

component main = OracleNote(20);
