// Range Check Components
// =======================
// Strict range checks for circuit signals.
// 
// Uses circomlib's Num2Bits for decomposition (safe, audited)
// but wraps with explicit sizing for 64-bit and 128-bit ranges.
//
// Includes:
//   - RangeCheck64: assert signal fits in 64 bits
//   - RangeCheck128: assert signal fits in 128 bits
//   - GreaterEqThan(n): explicitly-sized comparator
//
// CRITICAL: Every signal entering a multiplication MUST be range-checked
// to its actual maximum width, not a default.
//
// TODO: Sprint 1 implementation

pragma circom 2.1.0;
