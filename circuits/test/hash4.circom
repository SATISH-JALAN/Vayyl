pragma circom 2.1.0;
include "../lib/poseidon2.circom";

template Hash4() {
    signal input in[4];
    signal output out;
    component p = Poseidon2Hash_4();
    p.in[0] <== in[0];
    p.in[1] <== in[1];
    p.in[2] <== in[2];
    p.in[3] <== in[3];
    out <== p.out;
}

component main = Hash4();
