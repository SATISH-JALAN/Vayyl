pragma circom 2.1.0;

// Range Check Components
// =======================
// Strict range checks for circuit signals.
//
// Uses circomlib's Num2Bits for decomposition (safe, audited)
// but wraps with explicit sizing for 64-bit and 128-bit ranges.
//
// CRITICAL: Every signal entering a multiplication MUST be range-checked
// to its actual maximum width, not a default.

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// ─────────────────────────────────────────────────────────────
// RangeCheck64: Assert signal fits in 64 bits [0, 2^64)
// ─────────────────────────────────────────────────────────────
template RangeCheck64() {
    signal input in;

    // Decompose into 64 bits — if signal >= 2^64, this fails
    component n2b = Num2Bits(64);
    n2b.in <== in;
    // Num2Bits constrains: in === Σ(bits[i] * 2^i) for i in 0..63
    // This implicitly checks 0 <= in < 2^64
}

// ─────────────────────────────────────────────────────────────
// RangeCheck128: Assert signal fits in 128 bits [0, 2^128)
// ─────────────────────────────────────────────────────────────
template RangeCheck128() {
    signal input in;

    component n2b = Num2Bits(128);
    n2b.in <== in;
}

// ─────────────────────────────────────────────────────────────
// RangeCheckN: Assert signal fits in N bits [0, 2^N)
// Generic version — N must be specified at compile time
// ─────────────────────────────────────────────────────────────
template RangeCheckN(N) {
    signal input in;

    component n2b = Num2Bits(N);
    n2b.in <== in;
}

// ─────────────────────────────────────────────────────────────
// SafeGreaterEqThan: Explicitly-sized >= comparator
// Forces callers to specify bit width N, preventing silent
// overflow in comparisons.
//
// Output: 1 if a >= b, else 0
// Requires both a and b to fit in N bits.
// ─────────────────────────────────────────────────────────────
template SafeGreaterEqThan(N) {
    signal input a;
    signal input b;
    signal output out;

    // Range check both inputs to N bits
    component rc_a = Num2Bits(N);
    rc_a.in <== a;

    component rc_b = Num2Bits(N);
    rc_b.in <== b;

    // Use circomlib's GreaterEqThan comparator
    component geq = GreaterEqThan(N);
    geq.in[0] <== a;
    geq.in[1] <== b;

    out <== geq.out;
}

// ─────────────────────────────────────────────────────────────
// AssertGreaterEqThan: Like SafeGreaterEqThan but ASSERTS (fails proof)
// Use when the comparison must hold, not when you need a boolean signal.
// ─────────────────────────────────────────────────────────────
template AssertGreaterEqThan(N) {
    signal input a;
    signal input b;

    component geq = SafeGreaterEqThan(N);
    geq.a <== a;
    geq.b <== b;

    geq.out === 1;
}
