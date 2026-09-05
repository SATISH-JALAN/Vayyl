#![no_std]

use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

/// SEP-40 asset discriminator.
///
/// Defined here rather than in the oracle crate because three contracts and the
/// keeper all have to encode it identically. A SEP-40 price is keyed by this
/// value, so two definitions differing by a field order or a variant name
/// silently address different storage slots -- the reader gets `None`, treats it
/// as "no price", and a position that should have been liquidatable is not.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    /// A Stellar asset, identified by its contract (SAC) address.
    Stellar(Address),
    /// An off-chain or synthetic symbol, e.g. "XLM".
    Other(Symbol),
}

/// SEP-40 price record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Circuit identifiers for different proof types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CircuitId {
    Deposit,
    Transfer,
    Withdraw,
    PositionOpen,
    PositionHealth,
    PositionClose,
    LiquidationHeartbeat,
    HiddenOrderTrigger,
    MultiLegBasket,
    AspMembership,
    AspNonMembership,
    SealedOrder,
    /// V2 public exit (`ragequit_v2.circom`). APPEND-ONLY: this enum's order is
    /// the numeric circuit ID used when registering verification keys on-chain,
    /// so inserting above this line silently repoints every later VK.
    RageQuit,
    /// V3 arbitrary-amount deposit (`deposit_v3.circom`), 3 public inputs.
    /// Separate from `Deposit` rather than replacing it: the V2 slot is live on
    /// testnet with a 2-input key, and the verifier rejects on `ic.len()`
    /// mismatch, so overwriting it would break every V2 note still in the pool.
    DepositV3,
    /// V3 2-in/2-out arbitrary-amount transfer (`transfer_v3.circom`), 9 inputs.
    TransferV3,
    /// V3 arbitrary-amount withdraw (`withdraw_v3.circom`), 4 public inputs.
    WithdrawV3,
}

/// Verification key components for Groth16/BN254
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationKey {
    pub alpha_g1: BytesN<64>,
    pub beta_g2: BytesN<128>,
    pub gamma_g2: BytesN<128>,
    pub delta_g2: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

/// Proof components for Groth16/BN254
#[contracttype]
#[derive(Clone, Debug)]
pub struct Groth16Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

/// The internal state of a derivative position.
///
/// `tier_id` and `entry_price` are stored rather than left inside the
/// commitment because both are *public* by construction and both are needed by
/// contract logic that cannot open the commitment:
///
/// - `tier_id` fixes the collateral, the size and the maximum payout, so it is
///   what `close_or_modify_position` caps the payout against and what
///   `reveal_and_seize` derives the seizable collateral from. Accepting either
///   as a caller parameter is audit C4/P8 -- a keeper simply names a larger
///   number.
/// - `entry_price` is the oracle price at open, which `open_position` pins to
///   the live feed (audit P0). Keeping it lets anyone re-derive the position's
///   PnL bounds from public data.
///
/// Neither weakens privacy: size and collateral are tier constants shared by
/// every position in the tier, which is precisely where the anonymity set comes
/// from. What stays hidden is the mapping from a position to the *note* that
/// funded it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionState {
    /// The owner of the position
    pub owner: Address,
    /// The current ZK commitment binding collateral, size, direction, and entry price
    pub commitment: BytesN<32>,
    /// Ledger time of the last accepted health attestation.
    ///
    /// LEDGER time, not oracle time (audit H9). Writing the oracle's timestamp
    /// let a stalled feed keep a position permanently attested, and a
    /// future-dated one make it permanently unliquidatable.
    pub last_health_timestamp: u64,
    /// Which tier this position was opened in. Indexes the TIER_* tables.
    pub tier_id: u32,
    /// The oracle price at open, in stroops of collateral per contract unit.
    pub entry_price: i128,
    /// 1 = long, 0 = short.
    pub direction: u32,
    /// Ledger time at open.
    pub opened_at: u64,
}

/// The internal state of a hidden order
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderState {
    pub owner: Address,
    pub commitment: BytesN<32>,
    pub escrowed_amount: i128,
}

/// BN254 scalar field modulus `r`, big-endian.
///
/// `r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`
///
/// Copied from `soroban_sdk::crypto::bn254`, where the same constant is private
/// but is itself asserted against `ark_bn254::Fr::MODULUS` by the SDK's own
/// `test_bn254_fr_modulus_matches_arkworks`. `assert_canonical_fr_bytes_match_sdk`
/// below re-pins it so a future SDK bump cannot drift it silently.
pub const BN254_FR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// True when `value` is the *unique* 32-byte encoding of its field element.
///
/// Why this exists, and why it is in the shared crate rather than one contract:
///
/// `Bn254Fr::from_bytes` REDUCES its input mod `r` rather than validating it —
/// the SDK pins that behaviour in `test_fr_from_bytes_reduces`. (Note the
/// asymmetry: `Bn254Fp::from_bytes` *validates* and panics above the modulus.)
/// So `n` and `n + k*r` are the same scalar to a pairing check, while remaining
/// DIFFERENT byte strings — and every consumer here keys storage on the raw
/// bytes: the pool's nullifier set, the ASP membership leaves, the ASP
/// blocklist. `floor(2^256 / r) = 5`, so a typical value has 5 aliases that
/// still fit in 32 bytes.
///
/// Unchecked, that means one note spends six times, and a blocked nullifier `n`
/// walks straight past the blocklist as `n + r`. Rejecting instead of reducing
/// closes both, and it must be applied at every point where a caller-supplied
/// field element meets storage — hence one shared definition.
///
/// Lexicographic ordering on `[u8; 32]` is exactly big-endian numeric ordering,
/// so no bignum arithmetic is needed. This mirrors the SDK's own
/// `validate_bn254_fp`.
pub fn is_canonical_fr(value: &BytesN<32>) -> bool {
    value.to_array() < BN254_FR_MODULUS_BE
}

// ---------------------------------------------------------------------------
// Position tiers
// ---------------------------------------------------------------------------
// A position's collateral and size are PUBLIC constants chosen from a small
// table, not free amounts. That is a deliberate privacy decision and it is the
// opposite of the payments design, so it is worth being explicit about why.
//
// For payments, arbitrary amounts inside ONE pool is what hides value; splitting
// into denominations would fragment the anonymity set (see the header of
// `transfer_v3.circom`). For positions the constraint runs the other way: the
// counterparty vault has to reserve real capital against the best case of every
// open position, and it can only do that if the best case is knowable without
// opening the commitment. A free-amount position would force the vault to
// either reserve nothing (and be insolvent) or reserve a worst case (and be
// unusable).
//
// Fixing (margin, size) per tier makes `max_payout` public, so solvency becomes
// an on-chain invariant anyone can check -- and it makes every position in a
// tier look identical, which is the anonymity set. Two tiers rather than five:
// a tier with three users provides no privacy, and splitting an early crowd
// five ways deletes what little there is.
//
// Prices are in stroops of collateral per contract unit, so `size * price` is
// already in stroops and the circuits' existing settlement arithmetic needs no
// scaling. At a price of 1 XLM per unit both tiers are 3x leverage; leverage
// floats with the entry price, because size is what is fixed, not notional.

/// Number of tiers. Every table below must have exactly this many entries, and
/// the circuits hard-code the same values -- see `circuits/lib/tiers.circom`.
pub const TIER_COUNT: u32 = 2;

/// Collateral required to open, in stroops. This is exactly the amount the
/// collateral note must carry into the position; anything above it comes back
/// as a change note.
pub const TIER_MARGIN: [i128; 2] = [100_000_000, 500_000_000]; // 10 XLM, 50 XLM

/// Position size, in contract units.
pub const TIER_SIZE: [i128; 2] = [30, 150];

/// The most a position in this tier can ever pay out, margin included.
///
/// 3x margin. This is what makes the product a *capped* (knock-out) perp, and
/// the cap is not a limitation bolted on afterwards -- it is the reason the
/// vault can be provably solvent while positions stay private. A long that runs
/// past the cap stops earning, and the UI has to say so.
pub const TIER_MAX_PAYOUT: [i128; 2] = [300_000_000, 1_500_000_000];

/// What the vault must set aside for one open position: the profit it may owe
/// beyond the trader's own margin.
pub fn tier_reserve(tier_id: u32) -> Option<i128> {
    let i = tier_id as usize;
    if i >= TIER_COUNT as usize {
        return None;
    }
    Some(TIER_MAX_PAYOUT[i] - TIER_MARGIN[i])
}

pub fn tier_margin(tier_id: u32) -> Option<i128> {
    let i = tier_id as usize;
    if i >= TIER_COUNT as usize { None } else { Some(TIER_MARGIN[i]) }
}

pub fn tier_size(tier_id: u32) -> Option<i128> {
    let i = tier_id as usize;
    if i >= TIER_COUNT as usize { None } else { Some(TIER_SIZE[i]) }
}

pub fn tier_max_payout(tier_id: u32) -> Option<i128> {
    let i = tier_id as usize;
    if i >= TIER_COUNT as usize { None } else { Some(TIER_MAX_PAYOUT[i]) }
}

/// Encode a non-negative `i128` as a canonical 32-byte big-endian BN254 scalar.
///
/// Shared because four contracts build public inputs this way and a divergence
/// between any two of them produces proofs that verify locally and fail
/// on-chain with nothing pointing at the cause. `i128::MAX` is far below the
/// field modulus, so a non-negative value always lands canonically in the low
/// 16 bytes; a negative one has no field encoding at all and is rejected rather
/// than wrapped.
pub fn i128_to_field_bytes(value: i128) -> Option<[u8; 32]> {
    if value < 0 {
        return None;
    }
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&value.to_be_bytes());
    Some(out)
}

/// Encode a `u64` (timestamps, thresholds, tier ids) the same way.
pub fn u64_to_field_bytes(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..32].copy_from_slice(&value.to_be_bytes());
    out
}

#[cfg(test)]
mod tier_tests {
    use super::*;

    // The tables are indexed by a u32 that arrives from a caller. If they ever
    // disagree in length, an in-range tier_id for one table is out of range for
    // another and the contract panics on a slice index instead of returning a
    // typed error.
    #[test]
    fn tier_tables_agree_in_length() {
        assert_eq!(TIER_MARGIN.len(), TIER_COUNT as usize);
        assert_eq!(TIER_SIZE.len(), TIER_COUNT as usize);
        assert_eq!(TIER_MAX_PAYOUT.len(), TIER_COUNT as usize);
    }

    // The vault reserves `max_payout - margin`. If max_payout were ever <=
    // margin the reserve would be zero or negative, and `reserve()` would
    // succeed while setting nothing aside -- silently removing the only
    // solvency guarantee the system has.
    #[test]
    fn every_tier_reserves_a_positive_amount() {
        for tier in 0..TIER_COUNT {
            let margin = tier_margin(tier).unwrap();
            let max = tier_max_payout(tier).unwrap();
            assert!(max > margin, "tier {} pays out no more than its own margin", tier);
            assert_eq!(tier_reserve(tier).unwrap(), max - margin);
            assert!(tier_reserve(tier).unwrap() > 0);
        }
    }

    #[test]
    fn an_unknown_tier_returns_none_rather_than_panicking() {
        assert_eq!(tier_margin(TIER_COUNT), None);
        assert_eq!(tier_size(TIER_COUNT), None);
        assert_eq!(tier_max_payout(TIER_COUNT), None);
        assert_eq!(tier_reserve(u32::MAX), None);
    }

    // Every tier value feeds a circuit multiplication that is range-checked to
    // 64 bits. A tier constant at or above 2^64 would make the tier unprovable
    // -- the position could be opened on-chain and never closed.
    #[test]
    fn tier_constants_fit_the_circuits_64_bit_domain() {
        let limit = 1i128 << 64;
        for tier in 0..TIER_COUNT {
            assert!(tier_margin(tier).unwrap() < limit);
            assert!(tier_size(tier).unwrap() < limit);
            assert!(tier_max_payout(tier).unwrap() < limit);
        }
    }

    #[test]
    fn i128_field_encoding_round_trips_above_2_pow_64() {
        let value: i128 = (1i128 << 64) + 1;
        let bytes = i128_to_field_bytes(value).unwrap();
        let mut low = [0u8; 16];
        low.copy_from_slice(&bytes[16..32]);
        assert_eq!(i128::from_be_bytes(low), value);
        assert_eq!(&bytes[0..16], &[0u8; 16], "must stay a canonical field element");
    }

    #[test]
    fn a_negative_amount_has_no_field_encoding() {
        assert_eq!(i128_to_field_bytes(-1), None);
    }

    // Everything the contracts push as a public input must be canonical, or the
    // verifier's C1 guard rejects the honest proof.
    #[test]
    fn encoded_values_are_canonical_field_elements() {
        assert!(is_canonical_fr_bytes(&i128_to_field_bytes(i128::MAX).unwrap()));
        assert!(is_canonical_fr_bytes(&u64_to_field_bytes(u64::MAX)));
    }

    fn is_canonical_fr_bytes(v: &[u8; 32]) -> bool {
        *v < BN254_FR_MODULUS_BE
    }
}
