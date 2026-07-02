#![no_std]

use vayyl_types::{CircuitId, Groth16Proof, PositionState};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Vec,
};


#[contracttype]
#[derive(Clone)]
pub enum DataKey {
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
    pub fn initialize(env: Env, verifier: Address, oracle: Address, liquidation_engine: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }

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
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier), &true);
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
        
        let mut price_bytes = [0u8; 32];
        price_bytes[24..32].copy_from_slice(&price.to_be_bytes()[8..16]); // assuming positive i128
        public_inputs.push_back(BytesN::from_array(&env, &price_bytes));

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
        
        let mut price_bytes = [0u8; 32];
        price_bytes[24..32].copy_from_slice(&price.to_be_bytes()[8..16]);
        public_inputs.push_back(BytesN::from_array(&env, &price_bytes));

        let mut fee_bytes = [0u8; 32];
        fee_bytes[24..32].copy_from_slice(&fee.to_be_bytes()[8..16]);
        public_inputs.push_back(BytesN::from_array(&env, &fee_bytes));

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
}
