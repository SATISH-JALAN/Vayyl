pragma circom 2.1.0;
include "../lib/poseidon2.circom";
// Differential harness: Poseidon2 sponge hash of 3 inputs (t=4, rate=3, single block).
component main = Poseidon2Hash_3();
