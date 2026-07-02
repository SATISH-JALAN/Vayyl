
pragma circom 2.1.0;
include "../lib/babyjubjub.circom";

template TestDeriveKey() {
    signal input privKey;
    signal output pubX;
    signal output pubY;
    
    component dk = DerivePublicKey();
    dk.privKey <== privKey;
    pubX <== dk.pubX;
    pubY <== dk.pubY;
}

component main = TestDeriveKey();
