#![no_std]

use vayyl_types::{CircuitId, Groth16Proof, PositionState};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Vec,
};


#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this contract in place.
    Admin,
    Verifier,
    Oracle,
    LiquidationEngine,
    Position(BytesN<32>), // maps position_id to PositionState
    Nullifier(BytesN<32>), // tracks used nullifiers to prevent double spends
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
}

/// H3: nullifier persistence TTL (kept in sync with the pool's policy). A spent
/// position nullifier must outlive the note/position it spends, or that note
/// becomes re-spendable once its entry archives.
pub const PERSISTENT_TTL_THRESHOLD: u32 = 1_000_000;
pub const PERSISTENT_TTL_EXTEND: u32 = 3_000_000;

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

#[soroban_sdk::contractclient(name = "OracleInterfaceClient")]
pub trait OracleInterface {
    fn get_last_price(env: Env) -> (i128, u64);
}

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(env: Env, circuit_id: CircuitId, proof: Groth16Proof, public_inputs: Vec<BytesN<32>>) -> Result<bool, soroban_sdk::Error>;
}

#[soroban_sdk::contractclient(name = "LiquidationEngineClient")]
pub trait LiquidationEngineInterface {
    fn register_heartbeat(env: Env, position_id: BytesN<32>, timestamp: u64) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct PositionManager;

#[contractimpl]
impl PositionManager {
    /// Initialize the Position Manager
    pub fn initialize(env: Env, admin: Address, verifier: Address, oracle: Address, liquidation_engine: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::LiquidationEngine, &liquidation_engine);

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

    /// Open a new confidential derivative position using a shielded note as collateral
    pub fn open_position(
        env: Env,
        position_id: BytesN<32>,
        owner: Address,
        proof: Groth16Proof,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        position_commitment: BytesN<32>,
        meta_hash: BytesN<32>,
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
            owner,
            commitment: position_commitment,
            last_health_timestamp: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Position(position_id), &state);

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
        let oracle_client = OracleInterfaceClient::new(&env, &oracle);
        let (price, timestamp) = oracle_client.get_last_price();

        // 2. Verify ZK Proof for PositionHealth
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Public inputs: [position_commitment, oracle_price, oracle_timestamp]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(state.commitment.clone());

        // Full-i128 field encoding (no low-64-bit truncation).
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(price)?));

        let mut ts_bytes = [0u8; 32];
        ts_bytes[24..32].copy_from_slice(&timestamp.to_be_bytes());
        public_inputs.push_back(BytesN::from_array(&env, &ts_bytes));

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
        let oracle_client = OracleInterfaceClient::new(&env, &oracle);
        let (price, _timestamp) = oracle_client.get_last_price();

        // 2. Mark position nullifier
        Self::mark_nullifier(&env, position_nullifier.clone())?;

        // 3. Verify ZK Proof for PositionClose
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Public inputs: [position_nullifier, new_position_commitment, output_note_commitment, oracle_price, fee, meta_hash]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(position_nullifier);
        public_inputs.push_back(new_position_commitment.clone());
        public_inputs.push_back(output_note_commitment);
        
        // Full-i128 field encoding for both price and fee (no truncation).
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(price)?));
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(fee)?));

        public_inputs.push_back(meta_hash);

        let is_valid = verifier_client.verify(&CircuitId::PositionClose, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 4. Update state to point to new commitment (or remove if fully closed)
        let mut new_state = state.clone();
        new_state.commitment = new_position_commitment;
        new_state.last_health_timestamp = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Position(position_id), &new_state);

        Ok(())
    }

    pub fn get_position_state(env: Env, position_id: BytesN<32>) -> Result<PositionState, Error> {
        env.storage().persistent().get(&DataKey::Position(position_id)).ok_or(Error::PositionNotFound)
    }

    /// Get the admin authorized to upgrade this contract.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
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
        client.initialize(&admin, &verifier, &oracle, &le);
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
        let result = client.try_initialize(&a, &a, &a, &a);
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
}
