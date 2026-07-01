// Merkle Proof Verification using Poseidon2
// ===========================================
// Verifies a Merkle inclusion proof: given a leaf, path, and root,
// proves the leaf is in the tree at the given position.
//
// Uses Poseidon2 (t=3, rate=2) for internal node hashing.
// Tree depth set based on confirmed txMaxFootprintEntries.
//
// TODO: Sprint 1 — implement after Poseidon2 template is working

pragma circom 2.1.0;
