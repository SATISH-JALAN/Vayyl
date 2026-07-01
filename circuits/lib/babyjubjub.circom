pragma circom 2.1.0;

// BabyJubjub Point Operations
// ============================
// Wraps circomlib's safe, audited BabyJubjub components.
// 
// BabyJubjub parameters (twisted Edwards over BN254 F_r):
//   a·x² + y² = 1 + d·x²·y²
//   a = 168700, d = 168696
//
// Only imports BabyJubjub ops from circomlib.
// DO NOT import circomlib/circuits/poseidon.circom — that's Poseidon V1.

include "../node_modules/circomlib/circuits/babyjub.circom";
include "../node_modules/circomlib/circuits/escalarmulfix.circom";

// ─────────────────────────────────────────────────────────────
// DerivePublicKey: private key → (pub_x, pub_y)
// ─────────────────────────────────────────────────────────────
// Fixed-base scalar multiplication of priv_key by the BabyJubjub
// base point G.
//
// Base point (generator):
//   G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//
// Private key is decomposed into 253 bits (BN254 scalar field is ~254 bits,
// BabyJubjub subgroup order is ~253 bits).
template DerivePublicKey() {
    signal input privKey;
    signal output pubX;
    signal output pubY;

    // Base point as bit array for EscalarMulFix
    // EscalarMulFix takes the scalar as 253 individual bit signals
    // and the base point as a constant array [x, y]
    var BASE[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // Decompose private key into 253 bits
    component n2b = Num2Bits(253);
    n2b.in <== privKey;

    // Fixed-base scalar multiplication
    component mulFix = EscalarMulFix(253, BASE);
    for (var i = 0; i < 253; i++) {
        mulFix.e[i] <== n2b.out[i];
    }

    pubX <== mulFix.out[0];
    pubY <== mulFix.out[1];
}

// ─────────────────────────────────────────────────────────────
// BabyJubjubAdd: point addition
// ─────────────────────────────────────────────────────────────
template BabyJubjubAdd() {
    signal input x1;
    signal input y1;
    signal input x2;
    signal input y2;
    signal output xout;
    signal output yout;

    component adder = BabyAdd();
    adder.x1 <== x1;
    adder.y1 <== y1;
    adder.x2 <== x2;
    adder.y2 <== y2;

    xout <== adder.xout;
    yout <== adder.yout;
}

// ─────────────────────────────────────────────────────────────
// BabyJubjubCheck: verify a point is on the curve
// ─────────────────────────────────────────────────────────────
template BabyJubjubCheck() {
    signal input x;
    signal input y;

    component check = BabyCheck();
    check.x <== x;
    check.y <== y;
}
