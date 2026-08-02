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
include "../node_modules/circomlib/circuits/comparators.circom";

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
// The scalar MUST be canonical — constrained to [1, l) where l is the order of
// the base point. Two reasons, both load-bearing:
//
//   1. SOUNDNESS. G has order l, so privKey and privKey+l derive the SAME public
//      key — hence the same commitment and the same Merkle leaf — but
//      `nullifier = Poseidon2(commitment, privKey)` differs. An unbounded scalar
//      therefore yields one valid witness per multiple of l that stays in range,
//      i.e. one note spendable several times over. The earlier Num2Bits(253)
//      bound admitted 6 such witnesses per note. This is the F1 double-spend,
//      and closing it requires the range check to be l, not a power of two.
//   2. COMPLETENESS. l is 251 bits, so a canonical scalar always decomposes.
//      A field-wide scalar (Poseidon2 output reaches ~2^254) overflowed the old
//      253-bit bound roughly a third of the time and failed witness generation
//      outright — clients must reduce mod l before proving.
//
// l = 2736030358979909402780800718157159386076813972158567259200215660948447373041
template DerivePublicKey() {
    signal input privKey;
    signal output pubX;
    signal output pubY;

    // Base point as bit array for EscalarMulFix
    // EscalarMulFix takes the scalar as individual bit signals
    // and the base point as a constant array [x, y]
    var BASE[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // Order of BASE (the prime-order subgroup of BabyJubjub) — 251 bits.
    var SUBORDER =
        2736030358979909402780800718157159386076813972158567259200215660948447373041;

    // Decompose the private key into 251 bits — the exact width of l, so every
    // canonical scalar fits and nothing wider is representable.
    component n2b = Num2Bits(251);
    n2b.in <== privKey;

    // privKey < l. LessThan(251) internally range-checks to 252 bits; our inputs
    // are both < 2^251, so in[0] + 2^251 - in[1] <= 2^252 - 1 and cannot alias.
    component lt = LessThan(251);
    lt.in[0] <== privKey;
    lt.in[1] <== SUBORDER;
    lt.out === 1;

    // privKey != 0 — the zero scalar maps to the identity (0, 1), a public key
    // anyone can derive and therefore anyone can spend notes addressed to.
    signal privKeyInv;
    privKeyInv <-- 1 / privKey;
    privKey * privKeyInv === 1;

    // Fixed-base scalar multiplication
    component mulFix = EscalarMulFix(251, BASE);
    for (var i = 0; i < 251; i++) {
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
