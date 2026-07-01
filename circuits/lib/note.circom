// Core Note Primitive
// ====================
// The fundamental building block for all Vayyl circuits.
//
// commitment ≡ Poseidon2(amount, pub_x, pub_y, blindness)
// nullifier  ≡ Poseidon2(commitment, priv_key)
//
// Used by: Deposit, Transfer, Withdraw, PositionOpen, PositionClose
//
// TODO: Sprint 1 implementation (depends on Poseidon2 and BabyJubjub)

pragma circom 2.1.0;
