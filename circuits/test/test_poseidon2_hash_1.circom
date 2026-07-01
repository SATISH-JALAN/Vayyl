pragma circom 2.1.0;

include "../lib/poseidon2.circom";

// Test t=2 (rate 1)
component main {public [in]} = Poseidon2Hash_1();
