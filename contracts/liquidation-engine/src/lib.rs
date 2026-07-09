#![no_std]

use vayyl_types::{CircuitId, Groth16Proof, PositionState};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this contract in place.
    Admin,
    PositionManager,
    Verifier,
    /// D3: the VayylPool custody contract seizure is paid out from.
    Pool,
    GracePeriod,
    Heartbeat(BytesN<32>),
    KeeperEscrow(BytesN<32>),
    Liquidated(BytesN<32>),
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
}

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(env: Env, circuit_id: CircuitId, proof: Groth16Proof, public_inputs: Vec<BytesN<32>>) -> Result<bool, soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "PositionManagerClient")]
pub trait PositionManagerInterface {
    fn get_position_state(env: Env, position_id: BytesN<32>) -> Result<PositionState, soroban_sdk::Error>;
    fn mark_position_seized(env: Env, position_id: BytesN<32>) -> Result<(), soroban_sdk::Error>;
}

/// D3: decoupled client for the pool's settlement primitive. A seizure pays the
/// collateral out of the pool to the keeper via `execute_settlement`.
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

#[contract]
pub struct LiquidationEngineContract;

#[contractimpl]
impl LiquidationEngineContract {
    /// Initialize the Liquidation Engine with references to PositionManager and Groth16Verifier
    pub fn initialize(
        env: Env,
        admin: Address,
        position_manager: Address,
        verifier: Address,
        pool: Address,
        grace_period: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::PositionManager) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PositionManager, &position_manager);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::GracePeriod, &grace_period);
        Ok(())
    }

    /// Register a heartbeat for a position.
    /// Called by PositionManager after a successful attest_health().
    ///
    /// H5: gated on the PositionManager's authorization. Previously anyone could
    /// call this and reset any position's heartbeat, indefinitely blocking
    /// legitimate liquidations (a griefing / DoS hole). A contract automatically
    /// authorizes the direct sub-calls it makes, so PositionManager's invocation
    /// passes this check while any other caller is rejected.
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
        env.storage().persistent().set(&DataKey::Heartbeat(position_id), &timestamp);
        Ok(())
    }

    /// Initiate liquidation for a stale position.
    /// The keeper commits to a secret via keeper_commitment. They must reveal
    /// this secret later in reveal_and_seize() to claim the collateral.
    pub fn initiate_liquidation(
        env: Env,
        position_id: BytesN<32>,
        keeper_commitment: BytesN<32>,
    ) -> Result<(), Error> {
        // Check position hasn't already been liquidated
        if env.storage().persistent().has(&DataKey::Liquidated(position_id.clone())) {
            return Err(Error::AlreadyLiquidated);
        }

        let grace: u64 = env.storage().instance().get(&DataKey::GracePeriod).unwrap();
        let last_heartbeat: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Heartbeat(position_id.clone()))
            .ok_or(Error::HeartbeatNotFound)?;

        // Saturating add: a heartbeat near u64::MAX plus grace would otherwise
        // overflow and trap (overflow-checks are on in release), turning a normal
        // "not stale yet" path into an aborted transaction.
        if env.ledger().timestamp() < last_heartbeat.saturating_add(grace) {
            return Err(Error::PositionNotStale);
        }

        env.storage().persistent().set(
            &DataKey::KeeperEscrow(position_id),
            &keeper_commitment,
        );
        Ok(())
    }

    /// Reveal keeper secret and seize a stale position's collateral.
    ///
    /// Flow:
    /// 1. Verify the LiquidationHeartbeat ZK proof — proves the keeper knows
    ///    the position's private parameters and is bound to keeper_secret.
    /// 2. Verify that Poseidon2(keeper_secret, 0) matches the stored keeper_commitment.
    ///    This is done inside the circuit — the public input keeper_public_commitment
    ///    must match what was stored in initiate_liquidation().
    /// 3. Mark the position as liquidated.
    pub fn reveal_and_seize(
        env: Env,
        position_id: BytesN<32>,
        proof: Groth16Proof,
        position_commitment: BytesN<32>,
        keeper_public_commitment: BytesN<32>,
        timestamp: BytesN<32>,
        receiver: Address,
        seize_amount: i128,
    ) -> Result<(), Error> {
        // 1. Check position hasn't already been liquidated
        if env.storage().persistent().has(&DataKey::Liquidated(position_id.clone())) {
            return Err(Error::AlreadyLiquidated);
        }

        // 2. Verify the keeper_public_commitment matches what was escrowed
        let stored_commitment: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::KeeperEscrow(position_id.clone()))
            .ok_or(Error::EscrowNotFound)?;

        if stored_commitment != keeper_public_commitment {
            return Err(Error::KeeperMismatch);
        }

        // 3. Fetch position state from PositionManager to get the on-chain commitment
        let pm_addr: Address = env.storage().instance().get(&DataKey::PositionManager).unwrap();
        let pm_client = PositionManagerClient::new(&env, &pm_addr);
        let pos_state: PositionState = pm_client.get_position_state(&position_id);

        // 4. Verify the position_commitment matches what's on-chain
        if pos_state.commitment != position_commitment {
            return Err(Error::KeeperMismatch);
        }

        // 5. Verify ZK Proof for LiquidationHeartbeat
        let verifier_addr: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let verifier_client = Groth16VerifierClient::new(&env, &verifier_addr);

        // Public inputs: [position_commitment, keeper_public_commitment, timestamp]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(position_commitment);
        public_inputs.push_back(keeper_public_commitment);
        public_inputs.push_back(timestamp);

        let is_valid = verifier_client.verify(
            &CircuitId::LiquidationHeartbeat,
            &proof,
            &public_inputs,
        );
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 6. Mark position as liquidated (before the external payout — reentrancy /
        //    double-seize guard: a re-entered call sees Liquidated and aborts at step 1).
        env.storage().persistent().set(&DataKey::Liquidated(position_id.clone()), &true);

        // 7. Clean up escrow
        env.storage().persistent().remove(&DataKey::KeeperEscrow(position_id.clone()));

        // 8. Real seizure (D3): pay the collateral out of the pool to the keeper via
        //    `execute_settlement`. The liquidation-engine must be an allowlisted
        //    settlement authority on the pool; its own sub-call auto-authorizes.
        //
        //    V2: `seize_amount` is keeper-asserted until a LiquidationSeize circuit
        //    exposes collateral in the public inputs. The pool SAC balance is the
        //    hard cap (transfer fails if the pool can't cover it).
        if seize_amount > 0 {
            let pool_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::Pool)
                .ok_or(Error::EscrowNotFound)?;
            let pool_client = VayylPoolClient::new(&env, &pool_addr);
            let no_nullifiers: Vec<BytesN<32>> = Vec::new(&env);
            let no_commitments: Vec<BytesN<32>> = Vec::new(&env);
            pool_client.execute_settlement(
                &env.current_contract_address(),
                &no_nullifiers,
                &no_commitments,
                &Some(receiver),
                &seize_amount,
            );
        }

        // 9. Remove the position record from PositionManager.
        let _ = pm_client.mark_position_seized(&position_id);

        Ok(())
    }

    /// Check if a position is stale (past grace period without heartbeat)
    pub fn is_stale(env: Env, position_id: BytesN<32>) -> bool {
        let grace: u64 = env.storage().instance().get(&DataKey::GracePeriod).unwrap_or(0);
        let last_heartbeat: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Heartbeat(position_id))
            .unwrap_or(0);
        env.ledger().timestamp() > last_heartbeat.saturating_add(grace)
    }

    /// Check if a position has been liquidated
    pub fn is_liquidated(env: Env, position_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Liquidated(position_id))
    }

    /// Get the admin authorized to upgrade this contract.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::Unauthorized)
    }

    /// Upgrade the contract's WASM code in place (admin-gated).
    /// Keeps heartbeats, escrows, and liquidation flags intact.
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
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    fn setup(env: &Env) -> (LiquidationEngineContractClient<'static>, Address, Address) {
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let pm = Address::generate(env);
        let verifier = Address::generate(env);
        let pool = Address::generate(env);
        client.initialize(&admin, &pm, &verifier, &pool, &3600u64);
        (client, admin, pm)
    }

    #[test]
    fn test_initialize_and_admin() {
        let env = Env::default();
        let (client, admin, _pm) = setup(&env);
        assert_eq!(client.admin(), admin);
    }

    #[test]
    fn test_double_init_fails() {
        let env = Env::default();
        let (client, admin, pm) = setup(&env);
        let verifier = Address::generate(&env);
        let pool = Address::generate(&env);
        let result = client.try_initialize(&admin, &pm, &verifier, &pool, &3600u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_heartbeat_with_auth() {
        let env = Env::default();
        env.mock_all_auths(); // stands in for the PositionManager authorizing the sub-call
        let (client, _admin, _pm) = setup(&env);

        let position_id = BytesN::from_array(&env, &[1u8; 32]);
        client.register_heartbeat(&position_id, &1000u64);
        assert!(!client.is_stale(&position_id));
    }

    // H5: without the PositionManager's authorization, register_heartbeat is
    // rejected — this is the DoS fix (nobody can reset another position's clock).
    #[test]
    fn test_register_heartbeat_requires_auth() {
        let env = Env::default();
        let (client, _admin, _pm) = setup(&env);
        let position_id = BytesN::from_array(&env, &[1u8; 32]);
        let result = client.try_register_heartbeat(&position_id, &1000u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_is_stale_without_heartbeat() {
        let env = Env::default();
        let (client, _admin, _pm) = setup(&env);

        env.ledger().with_mut(|li| {
            li.timestamp = 7200; // well past a 3600s grace for a heartbeat at t=0
        });

        let position_id = BytesN::from_array(&env, &[2u8; 32]);
        assert!(client.is_stale(&position_id));
    }

    #[test]
    fn test_initiate_liquidation_not_stale_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _pm) = setup(&env);

        let position_id = BytesN::from_array(&env, &[3u8; 32]);
        let now = env.ledger().timestamp();
        client.register_heartbeat(&position_id, &now);

        let keeper_commitment = BytesN::from_array(&env, &[99u8; 32]);
        let result = client.try_initiate_liquidation(&position_id, &keeper_commitment);
        assert!(result.is_err());
    }

    // Saturating staleness math: a heartbeat near u64::MAX must not overflow-trap
    // when grace is added. `is_stale` should simply return false, not panic.
    #[test]
    fn test_is_stale_saturates_near_u64_max() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _pm) = setup(&env);

        let position_id = BytesN::from_array(&env, &[5u8; 32]);
        client.register_heartbeat(&position_id, &u64::MAX);
        // last_heartbeat + grace would overflow; saturating_add clamps to u64::MAX,
        // and now (small) < MAX, so the position is not stale — and no trap.
        assert!(!client.is_stale(&position_id));
    }

    #[test]
    fn test_is_liquidated_default_false() {
        let env = Env::default();
        let (client, _admin, _pm) = setup(&env);
        let position_id = BytesN::from_array(&env, &[4u8; 32]);
        assert!(!client.is_liquidated(&position_id));
    }

    // ---- D3/D4: real seizure moves collateral end-to-end -----------------

    use soroban_sdk::{contract as sdk_contract, contractimpl as sdk_contractimpl, token};

    /// Stand-in verifier that always accepts (real proofs need registered VKs).
    #[sdk_contract]
    pub struct MockVerifier;
    #[sdk_contractimpl]
    impl MockVerifier {
        pub fn verify(
            _env: Env,
            _circuit_id: CircuitId,
            _proof: Groth16Proof,
            _public_inputs: Vec<BytesN<32>>,
        ) -> Result<bool, soroban_sdk::Error> {
            Ok(true)
        }
    }

    #[contracttype]
    enum PmKey {
        Owner,
        Commit,
    }

    /// Stand-in PositionManager exposing exactly the getter the engine calls.
    #[sdk_contract]
    pub struct MockPM;
    #[sdk_contractimpl]
    impl MockPM {
        pub fn init(env: Env, owner: Address, commitment: BytesN<32>) {
            env.storage().instance().set(&PmKey::Owner, &owner);
            env.storage().instance().set(&PmKey::Commit, &commitment);
        }
        pub fn get_position_state(env: Env, _position_id: BytesN<32>) -> PositionState {
            PositionState {
                owner: env.storage().instance().get(&PmKey::Owner).unwrap(),
                commitment: env.storage().instance().get(&PmKey::Commit).unwrap(),
                last_health_timestamp: 0,
            }
        }
        pub fn mark_position_seized(_env: Env, _position_id: BytesN<32>) -> Result<(), soroban_sdk::Error> {
            Ok(())
        }
    }

    fn dummy_proof(env: &Env) -> Groth16Proof {
        Groth16Proof {
            a: BytesN::from_array(env, &[0u8; 64]),
            b: BytesN::from_array(env, &[0u8; 128]),
            c: BytesN::from_array(env, &[0u8; 64]),
        }
    }

    #[test]
    fn test_reveal_and_seize_moves_collateral_e2e() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        // SAC asset; the pool will custody the collateral.
        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();

        // Mock verifier (accepts) + mock PM returning a known position commitment.
        let verifier_id = env.register(MockVerifier, ());
        let position_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        let owner = Address::generate(&env);
        let pm_id = env.register(MockPM, ());
        MockPMClient::new(&env, &pm_id).init(&owner, &position_commitment);

        // Real pool, funded with collateral liquidity.
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        // Real liquidation engine wired to pool + mock PM + mock verifier.
        let le_id = env.register(LiquidationEngineContract, ());
        let le = LiquidationEngineContractClient::new(&env, &le_id);
        le.initialize(&admin, &pm_id, &verifier_id, &pool_id, &3600u64);

        // The engine must be an allowlisted settlement authority to move funds.
        pool.add_settlement_authority(&le_id);

        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let keeper_commitment = BytesN::from_array(&env, &[0x0C; 32]);

        // Heartbeat at t=0, then jump past the 3600s grace so the position is stale.
        le.register_heartbeat(&position_id, &0u64);
        env.ledger().with_mut(|li| li.timestamp = 7200);
        le.initiate_liquidation(&position_id, &keeper_commitment);

        // Reveal + seize 600 collateral to the keeper.
        let keeper = Address::generate(&env);
        let ts_bytes = BytesN::from_array(&env, &[0u8; 32]);
        le.reveal_and_seize(
            &position_id,
            &dummy_proof(&env),
            &position_commitment,
            &keeper_commitment,
            &ts_bytes,
            &keeper,
            &600i128,
        );

        // The seizure genuinely moved SAC: keeper credited, pool debited, flagged.
        assert!(le.is_liquidated(&position_id));
        assert_eq!(token::Client::new(&env, &asset).balance(&keeper), 600);
        assert_eq!(token::Client::new(&env, &asset).balance(&pool_id), 9_400);
    }

    // A seizure by a non-allowlisted engine must fail at the pool boundary — the
    // pool never pays out to an authority the admin didn't approve.
    #[test]
    fn test_seize_without_pool_allowlist_fails() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());
        let position_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        let owner = Address::generate(&env);
        let pm_id = env.register(MockPM, ());
        MockPMClient::new(&env, &pm_id).init(&owner, &position_commitment);

        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        let le_id = env.register(LiquidationEngineContract, ());
        let le = LiquidationEngineContractClient::new(&env, &le_id);
        le.initialize(&admin, &pm_id, &verifier_id, &pool_id, &3600u64);
        // NOTE: deliberately NOT allowlisted on the pool.

        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let keeper_commitment = BytesN::from_array(&env, &[0x0C; 32]);
        le.register_heartbeat(&position_id, &0u64);
        env.ledger().with_mut(|li| li.timestamp = 7200);
        le.initiate_liquidation(&position_id, &keeper_commitment);

        let keeper = Address::generate(&env);
        let ts_bytes = BytesN::from_array(&env, &[0u8; 32]);
        let res = le.try_reveal_and_seize(
            &position_id,
            &dummy_proof(&env),
            &position_commitment,
            &keeper_commitment,
            &ts_bytes,
            &keeper,
            &600i128,
        );
        assert!(res.is_err(), "seizure without pool allowlist must fail");
        assert_eq!(token::Client::new(&env, &asset).balance(&keeper), 0);
    }

    #[sdk_contract]
    pub struct MockVerifierFails;
    #[sdk_contractimpl]
    impl MockVerifierFails {
        pub fn verify(
            _env: Env,
            _circuit_id: CircuitId,
            _proof: Groth16Proof,
            _public_inputs: Vec<BytesN<32>>,
        ) -> Result<bool, soroban_sdk::Error> {
            Ok(false)
        }
    }

    #[test]
    fn test_reveal_and_seize_fails_if_proof_invalid() {
        let env = Env::default();
        env.mock_all_auths();

        let verifier_fails = env.register(MockVerifierFails, ());
        let position_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        let owner = Address::generate(&env);
        let pm_id = env.register(MockPM, ());
        MockPMClient::new(&env, &pm_id).init(&owner, &position_commitment);

        let admin = Address::generate(&env);
        let pool = Address::generate(&env);
        let le_id = env.register(LiquidationEngineContract, ());
        let le = LiquidationEngineContractClient::new(&env, &le_id);
        le.initialize(&admin, &pm_id, &verifier_fails, &pool, &3600u64);

        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let keeper_commitment = BytesN::from_array(&env, &[0x0C; 32]);
        le.register_heartbeat(&position_id, &0u64);
        env.ledger().with_mut(|li| li.timestamp = 7200);
        le.initiate_liquidation(&position_id, &keeper_commitment);

        let keeper = Address::generate(&env);
        let ts_bytes = BytesN::from_array(&env, &[0u8; 32]);
        let result = le.try_reveal_and_seize(
            &position_id,
            &dummy_proof(&env),
            &position_commitment,
            &keeper_commitment,
            &ts_bytes,
            &keeper,
            &600i128,
        );
        assert_eq!(result, Err(Ok(Error::InvalidProof)));
        assert!(!le.is_liquidated(&position_id));
    }
}
