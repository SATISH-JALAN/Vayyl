pragma circom 2.1.0;
include "../lib/poseidon2.circom";

template Hash2() {
    signal input in[2];
    signal output out;
    component p = Poseidon2Hash_2();
    p.in[0] <== in[0];
    p.in[1] <== in[1];
    out <== p.out;
}

component main = Hash2();
