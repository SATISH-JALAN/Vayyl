// BabyJubjub Point Operations
// ============================
// Wraps circomlib's safe, audited BabyJubjub components.
// 
// BabyJubjub parameters (twisted Edwards over BN254 F_r):
//   a·x² + y² = 1 + d·x²·y²
//   a = 168700, d = 168696
//
// Uses:
//   - circomlib/circuits/babyjub.circom (BabyAdd, BabyCheck)
//   - circomlib/circuits/escalarmulfix.circom (EscalarMulFix)
//
// DO NOT import circomlib/circuits/poseidon.circom — only BabyJubjub ops.
//
// TODO: Sprint 1 — implement DerivePublicKey wrapper

pragma circom 2.1.0;
