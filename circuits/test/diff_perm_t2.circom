pragma circom 2.1.0;
include "../lib/poseidon2.circom";
// Differential harness: raw Poseidon2 permutation, t=2. Exposes full output state.
component main = Poseidon2Perm_t2();
