pragma circom 2.1.0;

include "lib/poseidon2.circom";
include "lib/merkle.circom";

// ASP Membership Template
// Proves that a given public key (pubX, pubY) is in the ASP (Approved Service Provider) Merkle tree.
// Leaf = Poseidon2_2(pubX, pubY)

template ASPMembership(depth) {
    signal input pubX;
    signal input pubY;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    
    signal output root;

    // 1. Derive leaf = Poseidon2(pubX, pubY)
    component leafHasher = Poseidon2Hash_2();
    leafHasher.in[0] <== pubX;
    leafHasher.in[1] <== pubY;

    // 2. Merkle proof
    component tree = MerkleProof(depth);
    tree.leaf <== leafHasher.out;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    root <== tree.root;
}

// Instantiate the main component for the standalone compliance circuit if needed
// component main {public [root]} = ASPMembership(20);
