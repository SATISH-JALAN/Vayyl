pragma circom 2.1.0;

include "../lib/merkle.circom";

component main {public [leaf, pathElements, pathIndices]} = MerkleProof20();
