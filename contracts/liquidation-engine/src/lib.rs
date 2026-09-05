#![no_std]

//! Liquidation of positions whose owner stopped attesting.
//!
//! # The heartbeat model
//!
//! A position stays alive only while its owner can prove, in zero knowledge,
//! that it is solvent with maintenance margin (`PositionManager::attest_health`).
//! When they can no longer produce that proof — because the position has fallen
//! below the margin — the heartbeat goes stale and any keeper may seize it.
//! Nobody has to detect insolvency: it announces itself by silence.
//!
//! # Why there is no ZK proof on this path any more
//!
//! `reveal_and_seize` used to require a `LiquidationHeartbeat` proof that opened
//! the position commitment. That circuit was unsatisfiable by the only party
//! that ever calls this function.
//!
//! `PositionCommitment` binds `position_blindness`, which is the OWNER's secret.
//! A keeper does not have it and cannot obtain it, so no keeper could ever have
//! produced a valid proof. Every existing test passed because they used a mock
//! verifier that returns `true` unconditionally; the path had never been run
//! against a real one. A liquidation engine that cannot liquidate is worse than
//! none, because the positions look protected.
//!
//! Removing the proof loses nothing, because with tiered positions there is
//! nothing left for it to prove. The collateral at stake is `TIER_MARGIN[tier]`,
//! a public constant, and the tier is in `PositionState`. The proof's only other
//! job — binding the keeper to a secret they must later reveal — is a Poseidon2
//! preimage check, which this contract now performs itself against the same
//! host function the circuits use.
//!
//! # What the keeper commitment is for
//!
//! It stops a second keeper from watching the mempool, copying a pending
//! `reveal_and_seize`, and front-running the bounty. The keeper commits to
//! `Poseidon2(secret, 0)` when they initiate, and can only collect by revealing
//! `secret` — which nobody else knows until the transaction that spends it.

use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env, Vec,
};
use vayyl_types::{is_canonical_fr, tier_margin, PositionState};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PositionManager,
    Verifier,
    /// The VayylPool custody contract a seizure is paid out of.
    Pool,
    /// The counterparty vault that receives the seized collateral, net of the
    /// keeper's bounty.
    Vault,
    GracePeriod,
    Heartbeat(BytesN<32>),
    KeeperEscrow(BytesN<32>),
    Liquidated(BytesN<32>),
}

/// Who initiated a liquidation, and what they committed to.
///
/// The keeper's ADDRESS is stored alongside the commitment (H4). Previously only
/// the commitment was kept and `initiate_liquidation` was unauthenticated, so
/// anyone could overwrite a pending keeper's escrow with their own and take the
/// bounty for work someone else had already started.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperEscrow {
    pub keeper: Address,
    pub commitment: BytesN<32>,
    pub initiated_at: u64,
}

#[contractevent]
pub struct LiquidationInitiated {
    #[topic]
    pub position_id: BytesN<32>,
    #[topic]
    pub keeper: Address,
    pub initiated_at: u64,
}

#[contractevent]
pub struct PositionSeized {
    #[topic]
    pub position_id: BytesN<32>,
    #[topic]
    pub keeper: Address,
    pub collateral: i128,
    pub bounty: i128,
    pub to_vault: i128,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    PositionNotStale = 3,
    HeartbeatNotFound = 4,
    InvalidProof = 5,
    KeeperMismatch = 6,
    AlreadyLiquidated = 7,
    EscrowNotFound = 8,
    /// H4: another keeper already holds this position's escrow and it has not
    /// expired.
    EscrowHeld = 9,
    /// The revealed secret does not hash to the committed value.
    BadSecret = 10,
    /// A field element at or above the BN254 scalar modulus.
    NonCanonicalFieldElement = 11,
    /// The position's tier is not in the tier table, so there is no collateral
    /// figure to seize.
    UnknownTier = 12,
    /// The position no longer exists in the manager.
    PositionNotFound = 13,
}

const TTL_THRESHOLD: u32 = 500_000;
const TTL_EXTEND: u32 = 1_000_000;

/// The keeper's share of seized collateral, in basis points.
///
/// It has to be enough to cover gas and make watching worthwhile, and small
/// enough that liquidating is not more profitable than being the counterparty.
/// The remainder goes to the vault, i.e. to the LPs who were on the other side
/// of the trade and have just absorbed its outcome.
pub const KEEPER_BOUNTY_BPS: i128 = 500; // 5%

/// How long one keeper holds an exclusive claim after initiating.
///
/// Without an expiry, a keeper who initiates and then never reveals — because
/// they ran out of funds, or on purpose — would block that position from ever
/// being liquidated by anyone else.
pub const ESCROW_TTL: u64 = 900; // 15 minutes

#[soroban_sdk::contractclient(name = "PositionManagerClient")]
pub trait PositionManagerInterface {
    fn get_position_state(
        env: Env,
        position_id: BytesN<32>,
    ) -> Result<PositionState, soroban_sdk::Error>;
    fn mark_position_seized(env: Env, position_id: BytesN<32>) -> Result<(), soroban_sdk::Error>;
    fn release_seized_reservation(
        env: Env,
        position_id: BytesN<32>,
    ) -> Result<(), soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "VayylPoolClient")]
pub trait VayylPoolInterface {
    fn execute_settlement(
        env: Env,
        authority: Address,
        spent_nullifiers: Vec<BytesN<32>>,
        output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}

/// Poseidon2 over two field elements, byte-identical to the circuits' and the
/// pool's version.
///
/// Reduces into the field first: `poseidon2_hash` panics on any input at or
/// above the modulus, and roughly one in eight arbitrary 32-byte values is. The
/// reduction is what Circom does to the same signal, so the two agree.
fn hash2(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let to_fr = |b: &BytesN<32>| {
        soroban_sdk::crypto::bn254::Bn254Fr::from_u256(soroban_sdk::U256::from_be_bytes(
            env,
            &soroban_sdk::Bytes::from(b.clone()),
        ))
        .to_u256()
    };
    let mut inputs = Vec::new(env);
    inputs.push_back(to_fr(left));
    inputs.push_back(to_fr(right));

    let result = poseidon2_hash::<3, soroban_sdk::crypto::bn254::Bn254Fr>(env, &inputs);
    let bytes = result.to_be_bytes();
    let mut array = [0u8; 32];
    let copy_len = (array.len() as u32).min(bytes.len());
    bytes
        .slice(0..copy_len)
        .copy_into_slice(&mut array[(32 - copy_len) as usize..]);
    BytesN::from_array(env, &array)
}

#[contract]
pub struct LiquidationEngineContract;

#[contractimpl]
impl LiquidationEngineContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        position_manager: Address,
        verifier: Address,
        pool: Address,
        vault: Address,
        grace_period: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::PositionManager) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PositionManager, &position_manager);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.storage()
            .instance()
            .set(&DataKey::GracePeriod, &grace_period);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        Ok(())
    }

    /// Record a heartbeat. Callable only by the wired PositionManager.
    ///
    /// H5: gating this on the manager's authorization is what stops anyone from
    /// resetting an arbitrary position's clock and blocking legitimate
    /// liquidations indefinitely. A contract automatically authorizes its own
    /// direct sub-calls, so the manager passes while nobody else does.
    pub fn register_heartbeat(
        env: Env,
        position_id: BytesN<32>,
        timestamp: u64,
    ) -> Result<(), Error> {
        let pm: Address = env
            .storage()
            .instance()
            .get(&DataKey::PositionManager)
            .ok_or(Error::Unauthorized)?;
        pm.require_auth();
        let key = DataKey::Heartbeat(position_id);
        env.storage().persistent().set(&key, &timestamp);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        Ok(())
    }

    /// Claim the right to liquidate a stale position.
    ///
    /// H4: authenticated, and it will not displace a live claim. The keeper
    /// commits to `Poseidon2(secret, 0)` and must reveal `secret` to collect, so
    /// a watcher who copies this transaction learns nothing they can use.
    pub fn initiate_liquidation(
        env: Env,
        keeper: Address,
        position_id: BytesN<32>,
        keeper_commitment: BytesN<32>,
    ) -> Result<(), Error> {
        keeper.require_auth();
        if !is_canonical_fr(&keeper_commitment) {
            return Err(Error::NonCanonicalFieldElement);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Liquidated(position_id.clone()))
        {
            return Err(Error::AlreadyLiquidated);
        }
        if !Self::is_stale(env.clone(), position_id.clone()) {
            return Err(Error::PositionNotStale);
        }

        let now = env.ledger().timestamp();
        let escrow_key = DataKey::KeeperEscrow(position_id.clone());
        if let Some(existing) = env
            .storage()
            .persistent()
            .get::<DataKey, KeeperEscrow>(&escrow_key)
        {
            // Another keeper's claim stands until it expires. Letting a newcomer
            // overwrite it was the front-running hole; letting it stand forever
            // would be a permanent block, so it times out instead.
            if existing.keeper != keeper && now < existing.initiated_at.saturating_add(ESCROW_TTL) {
                return Err(Error::EscrowHeld);
            }
        }

        let escrow = KeeperEscrow {
            keeper: keeper.clone(),
            commitment: keeper_commitment,
            initiated_at: now,
        };
        env.storage().persistent().set(&escrow_key, &escrow);
        env.storage()
            .persistent()
            .extend_ttl(&escrow_key, TTL_THRESHOLD, TTL_EXTEND);

        LiquidationInitiated { position_id, keeper, initiated_at: now }.publish(&env);
        Ok(())
    }

    /// Reveal the keeper secret and seize a stale position's collateral.
    ///
    /// The order of checks is the substance of this function:
    ///
    /// 1. Not already liquidated.
    /// 2. The caller is the keeper who initiated, and their secret matches.
    /// 3. **The position is STILL stale.** H5: staleness was only checked at
    ///    `initiate_liquidation`, so an owner who cured their position in the
    ///    gap — by attesting health, which is exactly what they are supposed to
    ///    do — was liquidated anyway. Re-checking here is the difference between
    ///    a liquidation engine and a race.
    /// 4. The collateral comes from the position's TIER, not from the caller
    ///    (C4/P8). A keeper used to name `seize_amount` themselves, so anyone
    ///    who could stale-liquidate one position could name the whole pool.
    pub fn reveal_and_seize(
        env: Env,
        keeper: Address,
        position_id: BytesN<32>,
        keeper_secret: BytesN<32>,
    ) -> Result<i128, Error> {
        keeper.require_auth();
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);

        if env
            .storage()
            .persistent()
            .has(&DataKey::Liquidated(position_id.clone()))
        {
            return Err(Error::AlreadyLiquidated);
        }

        let escrow_key = DataKey::KeeperEscrow(position_id.clone());
        let escrow: KeeperEscrow = env
            .storage()
            .persistent()
            .get(&escrow_key)
            .ok_or(Error::EscrowNotFound)?;
        if escrow.keeper != keeper {
            return Err(Error::KeeperMismatch);
        }

        // The preimage check the circuit used to perform, done here against the
        // same host function the circuit compiles down to.
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        if hash2(&env, &keeper_secret, &zero) != escrow.commitment {
            return Err(Error::BadSecret);
        }

        // H5. The owner may have cured the position since the claim was staked.
        if !Self::is_stale(env.clone(), position_id.clone()) {
            return Err(Error::PositionNotStale);
        }

        let pm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::PositionManager)
            .ok_or(Error::Unauthorized)?;
        let pm = PositionManagerClient::new(&env, &pm_addr);
        let state: PositionState = pm.get_position_state(&position_id);

        // C4: the seizable amount is the tier's margin. Not a parameter.
        let collateral = tier_margin(state.tier_id).ok_or(Error::UnknownTier)?;
        let bounty = collateral * KEEPER_BOUNTY_BPS / 10_000;
        let to_vault = collateral - bounty;

        // Marked before any external call: a re-entered call aborts at step 1,
        // so the same collateral cannot be seized twice.
        env.storage()
            .persistent()
            .set(&DataKey::Liquidated(position_id.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Liquidated(position_id.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );
        env.storage().persistent().remove(&escrow_key);

        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::Unauthorized)?;
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::Unauthorized)?;
        let pool = VayylPoolClient::new(&env, &pool_addr);
        let none: Vec<BytesN<32>> = Vec::new(&env);

        // The collateral leaves the pool in two pieces, to two recipients, so it
        // takes two settlements: `execute_settlement` pays one address per call.
        if bounty > 0 {
            pool.execute_settlement(
                &env.current_contract_address(),
                &none,
                &none,
                &Some(keeper.clone()),
                &bounty,
            );
        }
        if to_vault > 0 {
            pool.execute_settlement(
                &env.current_contract_address(),
                &none,
                &none,
                &Some(vault_addr),
                &to_vault,
            );
        }

        // M2: neither of these is swallowed. A dropped `mark_position_seized`
        // leaves a ghost position the owner can still try to close; a dropped
        // `release_seized_reservation` strands vault capital permanently, which
        // would break the solvency invariant in the direction nobody checks.
        pm.release_seized_reservation(&position_id);
        pm.mark_position_seized(&position_id);

        PositionSeized {
            position_id,
            keeper,
            collateral,
            bounty,
            to_vault,
        }
        .publish(&env);

        Ok(collateral)
    }

    /// True when the position has missed its grace window.
    ///
    /// A position with no heartbeat at all reads as stale. That is correct in
    /// the only way it can occur: `open_position` registers a heartbeat in the
    /// same transaction, so a missing one means the position does not exist.
    pub fn is_stale(env: Env, position_id: BytesN<32>) -> bool {
        let grace: u64 = env
            .storage()
            .instance()
            .get(&DataKey::GracePeriod)
            .unwrap_or(0);
        let last_heartbeat: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Heartbeat(position_id))
            .unwrap_or(0);
        // Saturating: a heartbeat near u64::MAX plus grace would otherwise
        // overflow and trap, turning "not stale yet" into an aborted call.
        env.ledger().timestamp() > last_heartbeat.saturating_add(grace)
    }

    /// Seconds until this position becomes liquidatable; 0 if it already is.
    /// Read by the keeper so it can schedule rather than poll.
    pub fn seconds_until_stale(env: Env, position_id: BytesN<32>) -> u64 {
        let grace: u64 = env
            .storage()
            .instance()
            .get(&DataKey::GracePeriod)
            .unwrap_or(0);
        let last: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Heartbeat(position_id))
            .unwrap_or(0);
        let deadline = last.saturating_add(grace);
        let now = env.ledger().timestamp();
        if now >= deadline {
            0
        } else {
            deadline - now
        }
    }

    pub fn is_liquidated(env: Env, position_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Liquidated(position_id))
    }

    pub fn escrow_of(env: Env, position_id: BytesN<32>) -> Option<KeeperEscrow> {
        env.storage()
            .persistent()
            .get(&DataKey::KeeperEscrow(position_id))
    }

    pub fn grace_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::GracePeriod)
            .unwrap_or(0)
    }

    pub fn keeper_bounty_bps(_env: Env) -> i128 {
        KEEPER_BOUNTY_BPS
    }

    /// The commitment a keeper must publish for `secret`. Exposed so a keeper
    /// derives it from the same implementation the contract verifies against,
    /// rather than a second one that can disagree.
    pub fn keeper_commitment_for(env: Env, secret: BytesN<32>) -> BytesN<32> {
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        hash2(&env, &secret, &zero)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

#[cfg(test)]
mod test;
