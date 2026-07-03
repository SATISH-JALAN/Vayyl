pragma circom 2.1.0;
include "../lib/poseidon2.circom";
// Differential harness: Poseidon2 sponge hash of 5 inputs (t=4, two absorb blocks).
component main = Poseidon2Hash_5();
