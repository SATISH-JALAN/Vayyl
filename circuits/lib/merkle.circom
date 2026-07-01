pragma circom 2.1.0;

// Merkle Proof Verification using Poseidon2
// ===========================================
// Verifies a Merkle inclusion proof: given a leaf, path elements,
// path indices, and root, proves the leaf is in the tree.
//
// Uses Poseidon2Hash_2 (t=3, rate=2) for internal node hashing.
// Default tree depth: 20 (supports ~1M commitments per pool)
// Decision documented in docs/network-limits.md

include "poseidon2.circom";

// ─────────────────────────────────────────────────────────────
// HashLeftRight: hash two children to produce parent node
// ─────────────────────────────────────────────────────────────
// parent = Poseidon2Hash_2(left, right)
template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;

    component hasher = Poseidon2Hash_2();
    hasher.in[0] <== left;
    hasher.in[1] <== right;

    hash <== hasher.out;
}

// ─────────────────────────────────────────────────────────────
// DualMux: Select ordering based on path index
// ─────────────────────────────────────────────────────────────
// If s == 0: out[0] = in[0], out[1] = in[1]  (current node is LEFT child)
// If s == 1: out[0] = in[1], out[1] = in[0]  (current node is RIGHT child)
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    // s must be boolean
    s * (1 - s) === 0;

    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// ─────────────────────────────────────────────────────────────
// MerkleProof: Verify a Merkle inclusion proof
// ─────────────────────────────────────────────────────────────
// Inputs:
//   leaf: the leaf value (e.g., a note commitment)
//   pathElements[depth]: sibling hashes along the path
//   pathIndices[depth]: 0 if leaf is left child, 1 if right child
//
// Output:
//   root: the computed Merkle root
//
// The verifier recomputes the root from leaf to top and outputs it.
// The calling circuit constrains this output against the expected root.
template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component mux[depth];
    component hasher[depth];

    signal levelHash[depth + 1];
    levelHash[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // Select ordering: (current, sibling) or (sibling, current)
        mux[i] = DualMux();
        mux[i].in[0] <== levelHash[i];
        mux[i].in[1] <== pathElements[i];
        mux[i].s <== pathIndices[i];

        // Hash the pair
        hasher[i] = HashLeftRight();
        hasher[i].left <== mux[i].out[0];
        hasher[i].right <== mux[i].out[1];

        levelHash[i + 1] <== hasher[i].hash;
    }

    root <== levelHash[depth];
}

// ─────────────────────────────────────────────────────────────
// MerkleProof20: Convenience wrapper at depth 20
// ─────────────────────────────────────────────────────────────
template MerkleProof20() {
    signal input leaf;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal output root;

    component mp = MerkleProof(20);
    mp.leaf <== leaf;
    for (var i = 0; i < 20; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }

    root <== mp.root;
}
