#![no_std]

use vayyl_types::{CircuitId, Groth16Proof, PositionState};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env, Vec,
};


#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this contract in place.
    Admin,
    Verifier,
    Oracle,
    LiquidationEngine,
    /// D2: the VayylPool this manager settles through. Position close inserts the
    /// withdrawable output note into the pool tree via `execute_settlement`.
    Pool,
    Position(BytesN<32>), // maps position_id to PositionState
    Nullifier(BytesN<32>), // tracks used nullifiers to prevent double spends
}

#[contractevent]
pub struct PositionOpen {
    #[topic]
    pub position_id: BytesN<32>,
    #[topic]
    pub owner: Address,
    pub commitment: BytesN<32>,
    pub direction: u32,
    pub size: i128,
}

#[contractevent]
pub struct PositionHealth {
    #[topic]
    pub position_id: BytesN<32>,
    pub timestamp: u64,
}

#[contractevent]
pub struct PositionClose {
    #[topic]
    pub position_id: BytesN<32>,
    pub new_commitment: BytesN<32>,
    pub output_note_commitment: BytesN<32>,
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
}

/// H3: nullifier persistence TTL (kept in sync with the pool's policy). A spent
/// position nullifier must outlive the note/position it spends, or that note
/// becomes re-spendable once its entry archives.
pub const PERSISTENT_TTL_THRESHOLD: u32 = 1_000_000;
pub const PERSISTENT_TTL_EXTEND: u32 = 3_000_000;

/// Maintenance-margin ratio in HEALTH_SCALE (= 10000) units, matching
/// `position_health.circom`'s `health_threshold` public input. 500 = 5% of
/// notional required as equity buffer. A position that can no longer prove
/// health at this threshold cannot attest, so its heartbeat goes stale and it
/// becomes liquidatable — the threshold IS the liquidation trigger. This is a
/// PUBLIC input bound into the proof, so the prover cannot use a softer margin.
/// Tunable via `upgrade()` (changing it re-defines the on-chain policy; the
/// circuit reads whatever value the contract supplies).
pub const HEALTH_THRESHOLD: u64 = 500;

/// Encode a full i128 price/fee as a 32-byte big-endian field element.
///
/// The previous code copied only `to_be_bytes()[8..16]` — the low 64 bits — so
/// any value >= 2^64 was silently truncated and the resulting public input no
/// longer matched what the circuit hashed, so a valid proof would fail to verify
/// (or, worse, a crafted value could alias a different one mod 2^64). Prices and
/// fees are non-negative by protocol; i128::MAX < BN254 prime, so a non-negative
/// i128 is always a canonical field element in the low 16 bytes.
fn i128_to_field_bytes(value: i128) -> Result<[u8; 32], Error> {
    if value < 0 {
        return Err(Error::InvalidAmount);
    }
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&value.to_be_bytes());
    Ok(out)
}

#[contracttype]
pub enum Asset {
    Stellar(Address),
    Other(soroban_sdk::Symbol),
}

#[contracttype]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[soroban_sdk::contractclient(name = "ReflectorClient")]
pub trait ReflectorInterface {
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(env: Env, circuit_id: CircuitId, proof: Groth16Proof, public_inputs: Vec<BytesN<32>>) -> Result<bool, soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "LiquidationEngineClient")]
pub trait LiquidationEngineInterface {
    fn register_heartbeat(env: Env, position_id: BytesN<32>, timestamp: u64) -> Result<(), soroban_sdk::Error>;
}

/// D2: decoupled client for the pool's settlement primitive (mirrors the
/// verifier client). Position close routes the withdrawable output note through
/// `execute_settlement` so it lands in the pool's Merkle tree.
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
    fn pull_public_deposit(
        env: Env,
        authority: Address,
        depositor: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct PositionManager;

#[contractimpl]
impl PositionManager {
    /// Initialize the Position Manager
    pub fn initialize(env: Env, admin: Address, verifier: Address, oracle: Address, liquidation_engine: Address, pool: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::LiquidationEngine, &liquidation_engine);
        env.storage().instance().set(&DataKey::Pool, &pool);

        Ok(())
    }

    /// Internal function to check and mark a nullifier
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
        // H3: extend to the maximum practical persistent TTL so a spent nullifier
        // survives far past the default ~100k-ledger window.
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        Ok(())
    }

    /// Open a new confidential derivative position using a shielded note as collateral.
    ///
    /// Collateral is **not** pulled here — the owner must already hold a pool note
    /// (from a prior deposit). `open_position` consumes that note's nullifier via
    /// the PositionOpen proof; the collateral value lives in the pool Merkle tree
    /// until close/liquidation settles it through `execute_settlement`.
    pub fn open_position(
        env: Env,
        position_id: BytesN<32>,
        owner: Address,
        proof: Groth16Proof,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        position_commitment: BytesN<32>,
        meta_hash: BytesN<32>,
        direction: u32,
        size: i128,
    ) -> Result<(), Error> {
        owner.require_auth();

        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).ok_or(Error::NotInitialized)?;

        // 1. Mark collateral nullifier to prevent double spending
        Self::mark_nullifier(&env, nullifier.clone())?;

        // 2. Verify ZK Proof for PositionOpen
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Public inputs: [root, nullifier, position_commitment, meta_hash]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(root);
        public_inputs.push_back(nullifier);
        public_inputs.push_back(position_commitment.clone());
        public_inputs.push_back(meta_hash);

        let is_valid = verifier_client.verify(&CircuitId::PositionOpen, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 3. Store Position State
        let state = PositionState {
            owner: owner.clone(),
            commitment: position_commitment.clone(),
            last_health_timestamp: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Position(position_id.clone()), &state);

        PositionOpen {
            position_id,
            owner,
            commitment: position_commitment,
            direction,
            size,
        }
        .publish(&env);

        Ok(())
    }

    /// Attest to the health (solvency) of an open position against the current oracle price
    pub fn attest_health(
        env: Env,
        position_id: BytesN<32>,
        proof: Groth16Proof,
    ) -> Result<(), Error> {
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).ok_or(Error::NotInitialized)?;
        let oracle: Address = env.storage().instance().get(&DataKey::Oracle).unwrap();

        let mut state: PositionState = env.storage().persistent().get(&DataKey::Position(position_id.clone())).ok_or(Error::PositionNotFound)?;

        // 1. Fetch current oracle price and timestamp
        let oracle_client = ReflectorClient::new(&env, &oracle);
        let price_data = oracle_client.lastprice(&Asset::Other(soroban_sdk::Symbol::new(&env, "XLM")))
            .ok_or(Error::InvalidAmount)?; // Or maybe a dedicated Error::OracleError
        let price = price_data.price;
        let timestamp = price_data.timestamp;

        // 2. Verify ZK Proof for PositionHealth
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Public inputs: [position_commitment, oracle_price, oracle_timestamp, health_threshold]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(state.commitment.clone());

        // Full-i128 field encoding (no low-64-bit truncation).
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(price)?));

        let mut ts_bytes = [0u8; 32];
        ts_bytes[24..32].copy_from_slice(&timestamp.to_be_bytes());
        public_inputs.push_back(BytesN::from_array(&env, &ts_bytes));

        // Maintenance-margin threshold — bound into the proof so the owner must
        // prove solvency WITH margin, not bare break-even. Encoded as a canonical
        // field element (small value in the low 8 bytes), matching the circuit.
        let mut th_bytes = [0u8; 32];
        th_bytes[24..32].copy_from_slice(&HEALTH_THRESHOLD.to_be_bytes());
        public_inputs.push_back(BytesN::from_array(&env, &th_bytes));

        let is_valid = verifier_client.verify(&CircuitId::PositionHealth, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 3. Update health timestamp
        state.last_health_timestamp = timestamp;
        env.storage().persistent().set(&DataKey::Position(position_id.clone()), &state);

        // 4. Register heartbeat with LiquidationEngine (prevents position from going stale)
        if let Some(le_addr) = env.storage().instance().get::<DataKey, Address>(&DataKey::LiquidationEngine) {
            let le_client = LiquidationEngineClient::new(&env, &le_addr);
            let _ = le_client.register_heartbeat(&position_id, &timestamp);
        }

        PositionHealth {
            position_id,
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    /// Close or modify a position, settling PnL and generating a new commitment or returning funds
    pub fn close_or_modify_position(
        env: Env,
        position_id: BytesN<32>,
        proof: Groth16Proof,
        position_nullifier: BytesN<32>,
        new_position_commitment: BytesN<32>,
        output_note_commitment: BytesN<32>,
        fee: i128,
        meta_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).ok_or(Error::NotInitialized)?;
        let oracle: Address = env.storage().instance().get(&DataKey::Oracle).unwrap();

        let state: PositionState = env.storage().persistent().get(&DataKey::Position(position_id.clone())).ok_or(Error::PositionNotFound)?;
        state.owner.require_auth();

        // 1. Fetch settlement oracle price
        let oracle_client = ReflectorClient::new(&env, &oracle);
        let price_data = oracle_client.lastprice(&Asset::Other(soroban_sdk::Symbol::new(&env, "XLM")))
            .ok_or(Error::InvalidAmount)?;
        let price = price_data.price;

        // 2. Mark position nullifier
        Self::mark_nullifier(&env, position_nullifier.clone())?;

        // 3. Verify ZK Proof for PositionClose
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Public inputs: [position_nullifier, new_position_commitment, output_note_commitment, oracle_price, fee, meta_hash]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(position_nullifier);
        public_inputs.push_back(new_position_commitment.clone());
        public_inputs.push_back(output_note_commitment.clone());
        
        // Full-i128 field encoding for both price and fee (no truncation).
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(price)?));
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(fee)?));

        public_inputs.push_back(meta_hash);

        let is_valid = verifier_client.verify(&CircuitId::PositionClose, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 4. Real settlement (D2): insert the withdrawable output note into the
        //    pool's Merkle tree via `execute_settlement`. This is the fund movement
        //    that was previously missing — the settled collateral/PnL becomes a
        //    real shielded note the owner can later withdraw. The PositionClose
        //    circuit already enforced the balance equation
        //      old_collateral + old_size·asset = new_collateral + note_amount + fee + old_size·debt,
        //    so `output_note_commitment` is a sound note. The position nullifier is
        //    tracked here in the manager (step 2); no pool payout on close (the
        //    value stays shielded as the output note).
        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let pool_client = VayylPoolClient::new(&env, &pool_addr);
        let no_nullifiers: Vec<BytesN<32>> = Vec::new(&env);
        let mut out_commitments: Vec<BytesN<32>> = Vec::new(&env);
        out_commitments.push_back(output_note_commitment.clone());
        pool_client.execute_settlement(
            &env.current_contract_address(),
            &no_nullifiers,
            &out_commitments,
            &None,
            &0i128,
        );

        // 5. Update state to point to new commitment (or remove if fully closed)
        let mut new_state = state.clone();
        new_state.commitment = new_position_commitment.clone();
        new_state.last_health_timestamp = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Position(position_id.clone()), &new_state);

        PositionClose {
            position_id,
            new_commitment: new_position_commitment,
            output_note_commitment,
        }
        .publish(&env);

        Ok(())
    }

    pub fn get_position_state(env: Env, position_id: BytesN<32>) -> Result<PositionState, Error> {
        env.storage().persistent().get(&DataKey::Position(position_id)).ok_or(Error::PositionNotFound)
    }

    /// Mark a position as seized after liquidation. Callable only by the wired
    /// LiquidationEngine — removes the position record so `get_position_state`
    /// returns `PositionNotFound`.
    pub fn mark_position_seized(env: Env, position_id: BytesN<32>) -> Result<(), Error> {
        let le: Address = env
            .storage()
            .instance()
            .get(&DataKey::LiquidationEngine)
            .ok_or(Error::NotInitialized)?;
        le.require_auth();
        if !env.storage().persistent().has(&DataKey::Position(position_id.clone())) {
            return Err(Error::PositionNotFound);
        }
        env.storage().persistent().remove(&DataKey::Position(position_id));
        Ok(())
    }

    /// Get the admin authorized to upgrade this contract.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }

    /// The maintenance-margin ratio (HEALTH_SCALE = 10000 units) that
    /// `attest_health` binds into every health proof. Exposed for transparency
    /// so clients build the health witness against the same public value.
    pub fn health_threshold(_env: Env) -> u64 {
        HEALTH_THRESHOLD
    }

    /// Upgrade the contract's WASM code in place (admin-gated).
    /// Keeps every open position and spent nullifier intact.
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
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup(env: &Env) -> (PositionManagerClient<'static>, Address) {
        let contract_id = env.register(PositionManager, ());
        let client = PositionManagerClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let verifier = Address::generate(env);
        let oracle = Address::generate(env);
        let le = Address::generate(env);
        let pool = Address::generate(env);
        client.initialize(&admin, &verifier, &oracle, &le, &pool);
        (client, admin)
    }

    #[test]
    fn test_initialize_and_admin() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        assert_eq!(client.admin(), admin);
    }

    #[test]
    fn test_double_init_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let a = Address::generate(&env);
        let result = client.try_initialize(&a, &a, &a, &a, &a);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_missing_position_errors() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let pid = BytesN::from_array(&env, &[7u8; 32]);
        let result = client.try_get_position_state(&pid);
        assert!(result.is_err());
    }

    // The i128 field encoding must round-trip a value above 2^64 without
    // truncation (the old `to_be_bytes()[8..16]` slice dropped the high 64 bits).
    #[test]
    fn test_i128_field_encoding_no_truncation() {
        // 2^64 + 1 — high bits are non-zero, so a low-64-bit copy would lose them.
        let value: i128 = (1i128 << 64) + 1;
        let bytes = i128_to_field_bytes(value).unwrap();
        // Reconstruct the low-16-byte big-endian region and compare.
        let mut recon = [0u8; 16];
        recon.copy_from_slice(&bytes[16..32]);
        assert_eq!(i128::from_be_bytes(recon), value);
        // The top 16 bytes stay zero (canonical field element).
        assert_eq!(&bytes[0..16], &[0u8; 16]);
    }

    #[test]
    fn test_i128_field_encoding_rejects_negative() {
        assert_eq!(i128_to_field_bytes(-1), Err(Error::InvalidAmount));
    }

    // The maintenance-margin threshold is a fixed on-chain policy value that
    // attest_health binds into the proof; clients must read it to build a
    // witness the circuit will accept.
    #[test]
    fn test_health_threshold_getter_matches_const() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        assert_eq!(client.health_threshold(), HEALTH_THRESHOLD);
        // Non-zero: bare break-even (threshold 0) would defeat the liquidation
        // trigger — a real maintenance margin must be enforced.
        assert!(HEALTH_THRESHOLD > 0);
    }

    // The threshold must encode to the SAME canonical field element the circuit
    // reads: a small value in the low 8 bytes, high bytes zero. A mismatch here
    // silently makes every health proof fail to verify on-chain.
    #[test]
    fn test_health_threshold_field_encoding() {
        let mut th_bytes = [0u8; 32];
        th_bytes[24..32].copy_from_slice(&HEALTH_THRESHOLD.to_be_bytes());
        // Low 8 bytes reconstruct the value.
        let mut recon = [0u8; 8];
        recon.copy_from_slice(&th_bytes[24..32]);
        assert_eq!(u64::from_be_bytes(recon), HEALTH_THRESHOLD);
        // Everything above the low 8 bytes is zero (canonical field element).
        assert_eq!(&th_bytes[0..24], &[0u8; 24]);
    }

    // ---- D2/D4: close settles a real note into the pool tree -------------

    use soroban_sdk::{contract as sdk_contract, contractimpl as sdk_contractimpl};

    /// Stand-in verifier that always accepts.
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

    /// Stand-in oracle returning a fixed (price, timestamp).
    #[sdk_contract]
    pub struct MockOracle;
    #[sdk_contractimpl]
    impl MockOracle {
        pub fn lastprice(_env: Env, _asset: super::Asset) -> Option<super::PriceData> {
            Some(super::PriceData {
                price: 1000i128,
                timestamp: 0u64,
            })
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
    fn test_close_inserts_output_note_into_pool() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        // SAC asset for the pool; mock verifier + oracle for the manager.
        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());
        let oracle_id = env.register(MockOracle, ());

        // Real pool.
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);

        // Real position manager wired to the pool.
        let pm_id = env.register(PositionManager, ());
        let pm = PositionManagerClient::new(&env, &pm_id);
        pm.initialize(&admin, &verifier_id, &oracle_id, &dummy, &pool_id);

        // The manager must be an allowlisted settlement authority to insert notes.
        pool.add_settlement_authority(&pm_id);

        // Open a position (records PM state; nothing enters the pool tree yet).
        let owner = Address::generate(&env);
        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let pos_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        pm.open_position(
            &position_id,
            &owner,
            &dummy_proof(&env),
            &BytesN::from_array(&env, &[0x00; 32]), // root
            &BytesN::from_array(&env, &[0x0A; 32]), // collateral nullifier
            &pos_commitment,
            &BytesN::from_array(&env, &[0x0F; 32]), // meta_hash
        );
        assert_eq!(pool.get_leaf_count(), 0, "open alone inserts no pool leaf");

        // Close: the settled output note must be inserted into the pool tree.
        let output_note = BytesN::from_array(&env, &[0x0E; 32]);
        pm.close_or_modify_position(
            &position_id,
            &dummy_proof(&env),
            &BytesN::from_array(&env, &[0x0B; 32]), // position nullifier
            &BytesN::from_array(&env, &[0xC2; 32]), // new position commitment
            &output_note,
            &0i128,                                  // fee
            &BytesN::from_array(&env, &[0x0F; 32]),  // meta_hash
        );

        // The real fund movement: exactly one withdrawable note now exists.
        assert_eq!(pool.get_leaf_count(), 1, "close must insert the output note");
    }

    /// Stand-in verifier that always rejects.
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
    fn test_open_position_fails_if_proof_invalid() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register(PositionManager, ());
        let pm = PositionManagerClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let verifier_fails_id = env.register(MockVerifierFails, ());
        let oracle_id = env.register(MockOracle, ());
        let le_id = Address::generate(&env);
        let pool_id = Address::generate(&env);
        
        pm.initialize(&admin, &verifier_fails_id, &oracle_id, &le_id, &pool_id);

        let owner = Address::generate(&env);
        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let pos_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        
        let result = pm.try_open_position(
            &position_id,
            &owner,
            &dummy_proof(&env),
            &BytesN::from_array(&env, &[0x00; 32]), // root
            &BytesN::from_array(&env, &[0x0A; 32]), // collateral nullifier
            &pos_commitment,
            &BytesN::from_array(&env, &[0x0F; 32]), // meta_hash
        );
        
        assert_eq!(result, Err(Ok(Error::InvalidProof)));
    }

    #[test]
    fn test_attest_health_fails_if_proof_invalid() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register(PositionManager, ());
        let pm = PositionManagerClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let verifier_fails_id = env.register(MockVerifierFails, ());
        let oracle_id = env.register(MockOracle, ());
        let le_id = Address::generate(&env);
        let pool_id = Address::generate(&env);
        
        pm.initialize(&admin, &verifier_fails_id, &oracle_id, &le_id, &pool_id);
        
        let owner = Address::generate(&env);
        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let pos_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        
        let state = PositionState {
            owner: owner.clone(),
            commitment: pos_commitment,
            last_health_timestamp: 0,
        };
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&DataKey::Position(position_id.clone()), &state);
        });
        
        let result = pm.try_attest_health(&position_id, &dummy_proof(&env));
        assert_eq!(result, Err(Ok(Error::InvalidProof)));
    }

    #[test]
    fn test_close_or_modify_fails_if_proof_invalid() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register(PositionManager, ());
        let pm = PositionManagerClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let verifier_fails_id = env.register(MockVerifierFails, ());
        let oracle_id = env.register(MockOracle, ());
        let le_id = Address::generate(&env);
        let pool_id = Address::generate(&env);
        
        pm.initialize(&admin, &verifier_fails_id, &oracle_id, &le_id, &pool_id);
        
        let owner = Address::generate(&env);
        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let pos_commitment = BytesN::from_array(&env, &[0xC1; 32]);
        
        let state = PositionState {
            owner: owner.clone(),
            commitment: pos_commitment,
            last_health_timestamp: 0,
        };
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&DataKey::Position(position_id.clone()), &state);
        });
        
        let result = pm.try_close_or_modify_position(
            &position_id,
            &dummy_proof(&env),
            &BytesN::from_array(&env, &[0x0B; 32]), // position nullifier
            &BytesN::from_array(&env, &[0xC2; 32]), // new position commitment
            &BytesN::from_array(&env, &[0x0E; 32]), // output note commitment
            &0i128,                                  // fee
            &BytesN::from_array(&env, &[0x0F; 32]),  // meta_hash
        );
        
        assert_eq!(result, Err(Ok(Error::InvalidProof)));
    }

    #[test]
    fn test_mark_position_seized_requires_liquidation_engine_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PositionManager, ());
        let pm = PositionManagerClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let oracle = Address::generate(&env);
        let le = Address::generate(&env);
        let pool = Address::generate(&env);
        pm.initialize(&admin, &verifier, &oracle, &le, &pool);

        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let owner = Address::generate(&env);
        let state = PositionState {
            owner,
            commitment: BytesN::from_array(&env, &[0xC1; 32]),
            last_health_timestamp: 0,
        };
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&DataKey::Position(position_id.clone()), &state);
        });

        pm.mark_position_seized(&position_id);
        assert!(pm.try_get_position_state(&position_id).is_err());
    }

    #[test]
    fn test_mark_position_seized_rejects_non_liquidation_engine() {
        let env = Env::default();
        let contract_id = env.register(PositionManager, ());
        let pm = PositionManagerClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let oracle = Address::generate(&env);
        let le = Address::generate(&env);
        let pool = Address::generate(&env);
        pm.initialize(&admin, &verifier, &oracle, &le, &pool);

        let position_id = BytesN::from_array(&env, &[0x01; 32]);
        let result = pm.try_mark_position_seized(&position_id);
        assert!(result.is_err());
    }
}
