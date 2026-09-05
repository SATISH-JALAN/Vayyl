#![no_std]

//! Confidential directional positions.
//!
//! # What is private, and what is not
//!
//! Be precise about this, because "private positions" invites a stronger reading
//! than the design supports.
//!
//! PUBLIC, by construction: the owner's Stellar address, the tier (hence the
//! collateral and the size), the direction, the entry price, the settlement
//! price, and therefore the payout. The owner is public because closing is
//! gated on `require_auth`; the tier is public because that is what lets the
//! counterparty vault prove it can pay (see `vayyl-counterparty-vault`).
//!
//! PRIVATE: which shielded note funded the position, and which shielded note the
//! payout became. Both live in the pool's Merkle tree and are unlinkable to the
//! owner's deposit and withdrawal history. That is a real property -- it breaks
//! the chain from "this address opened a position" to "this address holds these
//! funds" -- and it is the property the UI is allowed to claim. Nothing more.
//!
//! # Why the payout is computed on-chain
//!
//! Every input to the payout is already public, so computing it here leaks
//! nothing that the events did not already carry, and it buys three things the
//! previous free-witness design could not have:
//!
//!   1. The vault knows what it owes, so profit can actually be paid and losses
//!      actually collected. Previously the settled amount existed only inside a
//!      commitment and no money moved between the vault and the pool at all.
//!   2. `payout` becomes a public input the circuit is bound to, so a prover
//!      cannot mint an output note for an amount of their choosing. The old
//!      circuit derived the amount from a balance equation over free witnesses
//!      including `entry_price` -- audit P0/C3.
//!   3. The cap is enforceable. `payout <= TIER_MAX_PAYOUT` is what makes the
//!      vault's reservation sufficient, and it is a public comparison.
//!
//! # Positions open and close whole
//!
//! There is no partial close. A tier fixes the size, so "close half" would
//! produce a position that belongs to no tier -- and an untiered position is one
//! the vault cannot reserve against. The previous `close_or_modify_position`
//! accepted a `new_position_commitment` for a modified position and was
//! therefore incompatible with tiering from the start.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env, Vec,
};
use vayyl_types::{
    i128_to_field_bytes, is_canonical_fr, tier_margin, tier_max_payout, tier_size,
    u64_to_field_bytes, Asset, CircuitId, Groth16Proof, PositionState, PriceData, TIER_COUNT,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this contract in place.
    Admin,
    Verifier,
    Oracle,
    /// The SEP-40 asset this manager prices positions in.
    OracleAsset,
    LiquidationEngine,
    /// The VayylPool this manager settles through.
    Pool,
    /// The counterparty vault that backs profit beyond a trader's own margin.
    Vault,
    Position(BytesN<32>),
    Nullifier(BytesN<32>),
}

#[contractevent]
pub struct PositionOpen {
    #[topic]
    pub position_id: BytesN<32>,
    #[topic]
    pub owner: Address,
    pub commitment: BytesN<32>,
    pub change_commitment: BytesN<32>,
    pub tier_id: u32,
    pub direction: u32,
    pub entry_price: i128,
    pub size: i128,
    pub margin: i128,
}

#[contractevent]
pub struct PositionHealth {
    #[topic]
    pub position_id: BytesN<32>,
    /// Ledger time the attestation was accepted, not the oracle's own stamp.
    pub timestamp: u64,
    pub oracle_price: i128,
}

#[contractevent]
pub struct PositionClose {
    #[topic]
    pub position_id: BytesN<32>,
    pub output_note_commitment: BytesN<32>,
    pub close_price: i128,
    pub payout: i128,
    pub fee: i128,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidProof = 3,
    NullifierAlreadyUsed = 4,
    PositionNotFound = 5,
    /// A price/fee value is negative — non-encodable as a BN254 field element.
    InvalidAmount = 6,
    /// Position was seized by the liquidation engine and is no longer active.
    PositionSeized = 7,
    /// C2: the caller supplied a Merkle root the pool never produced, so the
    /// collateral membership proof proves nothing about this pool's tree.
    UnknownRoot = 8,
    /// H6: `position_id` is already in use. Overwriting would replace the
    /// victim's `owner` and `commitment`, stranding their position — close
    /// requires `state.owner.require_auth()`, so they could never recover it.
    PositionAlreadyExists = 9,
    /// A field element at or above the BN254 scalar modulus (C1).
    NonCanonicalFieldElement = 10,
    /// `tier_id` is not one of the configured tiers.
    UnknownTier = 11,
    /// H9: the oracle price is older than MAX_ORACLE_AGE, or dated in the
    /// future. Acting on either turns a solvency check into a coin flip.
    StaleOracle = 12,
    /// The oracle has never published a price for this asset.
    NoOraclePrice = 13,
    /// `direction` must be 0 (short) or 1 (long).
    InvalidDirection = 14,
    /// A fee larger than the whole payout would make the output note negative.
    FeeExceedsPayout = 15,
    /// Price or fee outside the 64-bit domain every circuit range-checks to.
    /// Accepting one would produce a position that can be opened and never
    /// closed, because no satisfying witness exists.
    ValueOutOfRange = 16,
    /// Arithmetic overflow while computing the settlement.
    Overflow = 17,
    /// `position_id` is not a canonical field element, so it cannot be bound
    /// into the proof as a public input.
    InvalidPositionId = 18,
}

const PERSISTENT_TTL_THRESHOLD: u32 = 500_000;
const PERSISTENT_TTL_EXTEND: u32 = 1_000_000;

/// Maintenance-margin ratio in HEALTH_SCALE (10000) units. 500 = 5% of notional
/// required as equity.
///
/// A position that cannot prove health at this threshold cannot attest, so its
/// heartbeat goes stale and it becomes liquidatable — the threshold IS the
/// liquidation trigger. It is a PUBLIC input bound into the proof, so the prover
/// cannot substitute a softer margin.
pub const HEALTH_THRESHOLD: u64 = 500;

/// How old a price may be and still be acted on, in seconds.
///
/// H9. `attest_health` used to write `state.last_health_timestamp` straight from
/// the oracle, so a stalled feed kept every position permanently attested and a
/// future-dated one made them permanently unliquidatable. Five minutes is the
/// same order as Reflector's own resolution; anything longer and the price a
/// liquidation is judged against stops resembling the market.
pub const MAX_ORACLE_AGE: u64 = 300;

/// Everything the circuits range-check to 64 bits must stay below this.
const FIELD_64_LIMIT: i128 = 1i128 << 64;

// ---------------------------------------------------------------------------
// External interfaces
// ---------------------------------------------------------------------------

/// SEP-40. The same call reaches Reflector on mainnet and the mock feed on
/// testnet; nothing here knows which it is talking to.
#[soroban_sdk::contractclient(name = "OracleClient")]
pub trait SepFortyInterface {
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(
        env: Env,
        circuit_id: CircuitId,
        proof: Groth16Proof,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "LiquidationEngineClient")]
pub trait LiquidationEngineInterface {
    fn register_heartbeat(
        env: Env,
        position_id: BytesN<32>,
        timestamp: u64,
    ) -> Result<(), soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "VaultClient")]
pub trait CounterpartyVaultInterface {
    fn reserve(env: Env, position_id: BytesN<32>, tier_id: u32) -> Result<i128, soroban_sdk::Error>;
    fn release(
        env: Env,
        position_id: BytesN<32>,
        recipient: Address,
        payout: i128,
    ) -> Result<i128, soroban_sdk::Error>;
    fn free_balance(env: Env) -> Result<i128, soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "VayylPoolClient")]
pub trait VayylPoolInterface {
    fn is_known_root_public(env: Env, root: BytesN<32>) -> bool;

    fn execute_settlement(
        env: Env,
        authority: Address,
        spent_nullifiers: Vec<BytesN<32>>,
        output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

fn assert_canonical(value: &BytesN<32>) -> Result<(), Error> {
    if is_canonical_fr(value) {
        Ok(())
    } else {
        Err(Error::NonCanonicalFieldElement)
    }
}

fn field_i128(value: i128) -> Result<[u8; 32], Error> {
    i128_to_field_bytes(value).ok_or(Error::InvalidAmount)
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

/// The settled value of a position, in stroops, capped at the tier's maximum.
///
/// This is the whole product in six lines, so each one is load-bearing:
///
/// - PnL is `size * (close - entry)` for a long and the negation for a short.
///   `size` and both prices are tier constants or contract-supplied oracle
///   values, never caller data.
/// - The floor at 0 is what stops a position owing more than its margin. A
///   trader can lose everything they put in and nothing beyond it, so the
///   protocol never has to chase a debt it cannot see.
/// - The cap at `TIER_MAX_PAYOUT` is what makes the vault's reservation
///   sufficient. It also makes this a KNOCK-OUT perp: past the cap a winning
///   position stops earning. That is a real product limitation and the UI is
///   required to say so, because a trader who discovers it at settlement has
///   been misled.
pub fn settlement_payout(
    tier_id: u32,
    direction: u32,
    entry_price: i128,
    close_price: i128,
) -> Result<i128, Error> {
    let size = tier_size(tier_id).ok_or(Error::UnknownTier)?;
    let margin = tier_margin(tier_id).ok_or(Error::UnknownTier)?;
    let max_payout = tier_max_payout(tier_id).ok_or(Error::UnknownTier)?;

    let delta = match direction {
        1 => close_price.checked_sub(entry_price),
        0 => entry_price.checked_sub(close_price),
        _ => return Err(Error::InvalidDirection),
    }
    .ok_or(Error::Overflow)?;

    let pnl = size.checked_mul(delta).ok_or(Error::Overflow)?;
    let raw = margin.checked_add(pnl).ok_or(Error::Overflow)?;

    Ok(if raw < 0 {
        0
    } else if raw > max_payout {
        max_payout
    } else {
        raw
    })
}

#[contract]
pub struct PositionManager;

#[contractimpl]
impl PositionManager {
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        oracle: Address,
        oracle_asset: Asset,
        liquidation_engine: Address,
        pool: Address,
        vault: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::OracleAsset, &oracle_asset);
        env.storage()
            .instance()
            .set(&DataKey::LiquidationEngine, &liquidation_engine);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::Vault, &vault);
        extend_instance(&env);
        Ok(())
    }

    fn mark_nullifier(env: &Env, nullifier: BytesN<32>) -> Result<(), Error> {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier.clone()))
        {
            return Err(Error::NullifierAlreadyUsed);
        }
        let key = DataKey::Nullifier(nullifier);
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        Ok(())
    }

    /// Read the oracle and refuse anything a solvency decision must not rest on.
    ///
    /// Three rejections, each closing a distinct hole (H9/P4/P5):
    ///
    /// - `None`: the feed has never published. Treating a missing price as zero
    ///   makes every notional zero and every position trivially healthy.
    /// - Older than `MAX_ORACLE_AGE`: a stalled feed would otherwise let a
    ///   position keep attesting against a price the market left behind.
    /// - Dated in the future: reads as permanently fresh to every staleness
    ///   comparison, so one such record makes positions unliquidatable.
    ///
    /// The 64-bit bound is separate and is about completeness rather than
    /// safety: every circuit range-checks prices to 64 bits, so a larger price
    /// would make the position unprovable and therefore impossible to close.
    fn read_price(env: &Env) -> Result<PriceData, Error> {
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .ok_or(Error::NotInitialized)?;
        let asset: Asset = env
            .storage()
            .instance()
            .get(&DataKey::OracleAsset)
            .ok_or(Error::NotInitialized)?;

        let data = OracleClient::new(env, &oracle)
            .lastprice(&asset)
            .ok_or(Error::NoOraclePrice)?;

        if data.price <= 0 {
            return Err(Error::InvalidAmount);
        }
        if data.price >= FIELD_64_LIMIT {
            return Err(Error::ValueOutOfRange);
        }

        let now = env.ledger().timestamp();
        if data.timestamp > now {
            return Err(Error::StaleOracle);
        }
        if now - data.timestamp > MAX_ORACLE_AGE {
            return Err(Error::StaleOracle);
        }
        Ok(data)
    }

    /// Open a confidential directional position in `tier_id`.
    ///
    /// Collateral is a shielded note the owner already holds. The note is spent
    /// in full: exactly `TIER_MARGIN[tier_id]` becomes the position's margin and
    /// the remainder comes back as `change_commitment`, a fresh note in the
    /// pool. Without that change output a trader would need a note of exactly
    /// the tier margin and no other, which is not a limitation any user could
    /// reasonably work around.
    pub fn open_position(
        env: Env,
        position_id: BytesN<32>,
        owner: Address,
        tier_id: u32,
        direction: u32,
        proof: Groth16Proof,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        position_commitment: BytesN<32>,
        change_commitment: BytesN<32>,
    ) -> Result<(), Error> {
        owner.require_auth();
        extend_instance(&env);

        if tier_id >= TIER_COUNT {
            return Err(Error::UnknownTier);
        }
        if direction > 1 {
            return Err(Error::InvalidDirection);
        }

        // `position_id` is a public input, so it must be a canonical field
        // element or the verifier's C1 guard rejects every honest proof.
        assert_canonical(&position_id)?;
        assert_canonical(&root)?;
        assert_canonical(&nullifier)?;
        assert_canonical(&position_commitment)?;
        assert_canonical(&change_commitment)?;

        // H6: refuse to overwrite. `set` on a duplicate id replaced the record's
        // owner and commitment, and close is gated on `state.owner.require_auth()`
        // -- so the original owner lost the position permanently.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Position(position_id.clone()))
        {
            return Err(Error::PositionAlreadyExists);
        }

        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let pool_client = VayylPoolClient::new(&env, &pool_addr);

        // C2: bind `root` to one the pool actually produced, BEFORE it becomes a
        // public input. Without this the membership proof is against a tree the
        // attacker built, so the collateral it proves can be any amount they
        // like. Checked before anything is written so a bad root leaves no
        // residue and cannot burn the caller's collateral note.
        if !pool_client.is_known_root_public(&root) {
            return Err(Error::UnknownRoot);
        }

        let price = Self::read_price(&env)?;

        // Reserve BEFORE verifying. Both orders are safe -- a later failure
        // reverts the whole transaction -- but this one fails the cheap check
        // first, so a trader hitting a full vault does not pay for a pairing
        // check to find out. "The counterparty is full" is a normal state.
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)?;
        VaultClient::new(&env, &vault_addr).reserve(&position_id, &tier_id);

        Self::mark_nullifier(&env, nullifier.clone())?;

        // Public inputs, in the exact order `position_open.circom` declares them.
        // A reordering here verifies against nothing and fails on-chain with no
        // indication of why.
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(root);
        public_inputs.push_back(nullifier.clone());
        public_inputs.push_back(position_commitment.clone());
        public_inputs.push_back(change_commitment.clone());
        public_inputs.push_back(BytesN::from_array(&env, &u64_to_field_bytes(tier_id as u64)));
        public_inputs.push_back(BytesN::from_array(&env, &field_i128(price.price)?));
        public_inputs.push_back(BytesN::from_array(
            &env,
            &u64_to_field_bytes(direction as u64),
        ));
        public_inputs.push_back(position_id.clone());

        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::PositionOpen,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        // Spend the collateral note in the pool's canonical nullifier set and
        // insert the change note. Tracking the nullifier only here would leave
        // the same note withdrawable from VayylPool after it had been committed
        // as collateral.
        let mut spent = Vec::new(&env);
        spent.push_back(nullifier);
        let mut outputs = Vec::new(&env);
        outputs.push_back(change_commitment.clone());
        pool_client.execute_settlement(
            &env.current_contract_address(),
            &spent,
            &outputs,
            &None,
            &0i128,
        );

        let now = env.ledger().timestamp();
        let state = PositionState {
            owner: owner.clone(),
            commitment: position_commitment.clone(),
            last_health_timestamp: now,
            tier_id,
            entry_price: price.price,
            direction,
            opened_at: now,
        };
        let key = DataKey::Position(position_id.clone());
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        // M2: the heartbeat registration is NOT swallowed. A failure here would
        // leave a position that looks liquidatable from the first ledger while
        // the owner was told the open succeeded; letting it abort the whole
        // transaction is the only outcome that keeps the two views consistent.
        Self::liquidation_engine(&env)?.register_heartbeat(&position_id, &now);

        PositionOpen {
            position_id,
            owner,
            commitment: position_commitment,
            change_commitment,
            tier_id,
            direction,
            entry_price: price.price,
            size: tier_size(tier_id).ok_or(Error::UnknownTier)?,
            margin: tier_margin(tier_id).ok_or(Error::UnknownTier)?,
        }
        .publish(&env);

        Ok(())
    }

    fn liquidation_engine(env: &Env) -> Result<LiquidationEngineClient<'static>, Error> {
        let addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::LiquidationEngine)
            .ok_or(Error::NotInitialized)?;
        Ok(LiquidationEngineClient::new(env, &addr))
    }

    /// Prove the position is still solvent with maintenance margin, refreshing
    /// its heartbeat.
    ///
    /// Anyone may submit; the proof is the authorisation. That is deliberate —
    /// a relayer or a watchtower should be able to keep a position alive on the
    /// owner's behalf without holding their keys, and the proof cannot be
    /// produced without them anyway (P7: the circuit derives the position's
    /// public key from the owner's spend key).
    pub fn attest_health(
        env: Env,
        position_id: BytesN<32>,
        proof: Groth16Proof,
    ) -> Result<(), Error> {
        extend_instance(&env);
        let key = DataKey::Position(position_id.clone());
        let mut state: PositionState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PositionNotFound)?;

        let price = Self::read_price(&env)?;

        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;

        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(state.commitment.clone());
        public_inputs.push_back(BytesN::from_array(&env, &field_i128(price.price)?));
        public_inputs.push_back(BytesN::from_array(&env, &u64_to_field_bytes(price.timestamp)));
        public_inputs.push_back(BytesN::from_array(
            &env,
            &u64_to_field_bytes(HEALTH_THRESHOLD),
        ));

        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::PositionHealth,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        // H9: LEDGER time, not the oracle's. `read_price` has already bounded
        // how far apart they may be; storing the oracle's own stamp let a feed
        // that stopped updating keep a position attested forever, and a
        // future-dated one make it unliquidatable forever.
        let now = env.ledger().timestamp();
        state.last_health_timestamp = now;
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        Self::liquidation_engine(&env)?.register_heartbeat(&position_id, &now);

        PositionHealth {
            position_id,
            timestamp: now,
            oracle_price: price.price,
        }
        .publish(&env);

        Ok(())
    }

    /// Close a position in full and mint the payout as a shielded note.
    ///
    /// The money moves in one of two directions, and both go through contracts
    /// that already own the relevant custody:
    ///
    /// - In profit, the vault sends `payout - margin` to the pool, then the pool
    ///   inserts an output note worth `payout - fee`.
    /// - At a loss, the pool sends `margin - payout` to the vault (paying the
    ///   LPs who were the counterparty) and inserts the smaller note.
    ///
    /// The trader's margin never moves: it entered the pool as a note at deposit
    /// time and leaves as a note now.
    pub fn close_position(
        env: Env,
        position_id: BytesN<32>,
        proof: Groth16Proof,
        position_nullifier: BytesN<32>,
        output_note_commitment: BytesN<32>,
        fee: i128,
    ) -> Result<(), Error> {
        extend_instance(&env);
        assert_canonical(&position_id)?;
        assert_canonical(&position_nullifier)?;
        assert_canonical(&output_note_commitment)?;
        if fee < 0 {
            return Err(Error::InvalidAmount);
        }
        if fee >= FIELD_64_LIMIT {
            return Err(Error::ValueOutOfRange);
        }

        let key = DataKey::Position(position_id.clone());
        let state: PositionState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PositionNotFound)?;
        state.owner.require_auth();

        let price = Self::read_price(&env)?;
        let payout = settlement_payout(
            state.tier_id,
            state.direction,
            state.entry_price,
            price.price,
        )?;
        if fee > payout {
            return Err(Error::FeeExceedsPayout);
        }
        let margin = tier_margin(state.tier_id).ok_or(Error::UnknownTier)?;

        Self::mark_nullifier(&env, position_nullifier.clone())?;

        // C3: the OLD position commitment is a public input supplied by the
        // CONTRACT, from stored state -- never by the caller. Left as a free
        // witness, a prover could open any position they liked, including one
        // that never existed, and settle it.
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(position_nullifier.clone());
        public_inputs.push_back(output_note_commitment.clone());
        public_inputs.push_back(state.commitment.clone());
        public_inputs.push_back(BytesN::from_array(
            &env,
            &u64_to_field_bytes(state.tier_id as u64),
        ));
        public_inputs.push_back(BytesN::from_array(&env, &field_i128(state.entry_price)?));
        public_inputs.push_back(BytesN::from_array(
            &env,
            &u64_to_field_bytes(state.direction as u64),
        ));
        public_inputs.push_back(BytesN::from_array(&env, &field_i128(payout)?));
        public_inputs.push_back(BytesN::from_array(&env, &field_i128(fee)?));
        public_inputs.push_back(position_id.clone());

        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::PositionClose,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)?;
        let vault = VaultClient::new(&env, &vault_addr);

        let mut outputs = Vec::new(&env);
        outputs.push_back(output_note_commitment.clone());

        if payout > margin {
            // Profit: the vault tops the pool up first, so the pool is already
            // solvent for the note it is about to mint. Doing it the other way
            // round would leave a window in which the tree holds a note the pool
            // cannot honour.
            vault.release(&position_id, &pool_addr, &(payout - margin));
            VayylPoolClient::new(&env, &pool_addr).execute_settlement(
                &env.current_contract_address(),
                &Vec::new(&env),
                &outputs,
                &None,
                &0i128,
            );
        } else {
            // Loss (or exactly break-even): free the reserve, and hand the
            // forfeited part of the margin to the vault. This is the LPs' return
            // and it is the only reason anyone would fund the counterparty.
            vault.release(&position_id, &vault_addr, &0i128);
            VayylPoolClient::new(&env, &pool_addr).execute_settlement(
                &env.current_contract_address(),
                &Vec::new(&env),
                &outputs,
                &Some(vault_addr),
                &(margin - payout),
            );
        }

        env.storage().persistent().remove(&key);

        PositionClose {
            position_id,
            output_note_commitment,
            close_price: price.price,
            payout,
            fee,
        }
        .publish(&env);

        Ok(())
    }

    // ---- views -------------------------------------------------------------

    pub fn get_position_state(env: Env, position_id: BytesN<32>) -> Result<PositionState, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(Error::PositionNotFound)
    }

    /// What this position would settle for at `close_price`, right now.
    ///
    /// Exposed so the UI shows the same number the contract will compute, rather
    /// than a client-side reimplementation that can drift from it.
    pub fn quote_payout(env: Env, position_id: BytesN<32>, close_price: i128) -> Result<i128, Error> {
        let state: PositionState = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(Error::PositionNotFound)?;
        settlement_payout(state.tier_id, state.direction, state.entry_price, close_price)
    }

    /// The live oracle price, with the same staleness rules the write paths use.
    /// A client that reads this and gets an error knows an open would fail for
    /// the same reason, before asking the user to prove anything.
    pub fn current_price(env: Env) -> Result<PriceData, Error> {
        Self::read_price(&env)
    }

    pub fn health_threshold(_env: Env) -> u64 {
        HEALTH_THRESHOLD
    }

    pub fn max_oracle_age(_env: Env) -> u64 {
        MAX_ORACLE_AGE
    }

    /// The tier table, as `(margin, size, max_payout)` per tier id.
    pub fn tiers(env: Env) -> Vec<(i128, i128, i128)> {
        let mut out = Vec::new(&env);
        for tier in 0..TIER_COUNT {
            out.push_back((
                tier_margin(tier).unwrap_or(0),
                tier_size(tier).unwrap_or(0),
                tier_max_payout(tier).unwrap_or(0),
            ));
        }
        out
    }

    pub fn vault(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Vault).ok_or(Error::NotInitialized)
    }

    pub fn pool(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Pool).ok_or(Error::NotInitialized)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }

    // ---- lifecycle ---------------------------------------------------------

    /// Remove a seized position. Callable only by the wired LiquidationEngine.
    pub fn mark_position_seized(env: Env, position_id: BytesN<32>) -> Result<(), Error> {
        let le: Address = env
            .storage()
            .instance()
            .get(&DataKey::LiquidationEngine)
            .ok_or(Error::NotInitialized)?;
        le.require_auth();
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Position(position_id.clone()))
        {
            return Err(Error::PositionNotFound);
        }
        env.storage()
            .persistent()
            .remove(&DataKey::Position(position_id));
        Ok(())
    }

    /// Release a seized position's vault reservation.
    ///
    /// Split from `mark_position_seized` because the two have different failure
    /// consequences: failing to remove the record leaves a ghost position, while
    /// failing to release strands vault capital forever. The liquidation engine
    /// calls both, and neither is allowed to silently not happen.
    pub fn release_seized_reservation(env: Env, position_id: BytesN<32>) -> Result<(), Error> {
        let le: Address = env
            .storage()
            .instance()
            .get(&DataKey::LiquidationEngine)
            .ok_or(Error::NotInitialized)?;
        le.require_auth();
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)?;
        VaultClient::new(&env, &vault_addr).release(&position_id, &vault_addr, &0i128);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

#[cfg(test)]
mod test;

// The same vertical against the REAL VayylPool, VayylCounterpartyVault and
// MockOracle. Separate from `test` because it needs a heavier fixture and
// because the properties it pins only exist at the seam between contracts --
// which is exactly where audit M3 lived undetected.
#[cfg(test)]
mod integration_test;
