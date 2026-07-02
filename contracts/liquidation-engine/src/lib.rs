#![no_std]

use vayyl_types::{CircuitId, Groth16Proof, PositionState};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    PositionManager,
    Verifier,
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
}

#[contract]
pub struct LiquidationEngineContract;

#[contractimpl]
impl LiquidationEngineContract {
    /// Initialize the Liquidation Engine with references to PositionManager and Groth16Verifier
    pub fn initialize(
        env: Env,
        position_manager: Address,
        verifier: Address,
        grace_period: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::PositionManager) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::PositionManager, &position_manager);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::GracePeriod, &grace_period);
        Ok(())
    }

    /// Register a heartbeat for a position.
    /// Called by PositionManager after a successful attest_health().
    pub fn register_heartbeat(
        env: Env,
        position_id: BytesN<32>,
        timestamp: u64,
    ) -> Result<(), Error> {
        // In production, verify caller is PositionManager:
        // let pm: Address = env.storage().instance().get(&DataKey::PositionManager).unwrap();
        // pm.require_auth();
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

        if env.ledger().timestamp() < last_heartbeat + grace {
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

        // 6. Mark position as liquidated
        env.storage().persistent().set(&DataKey::Liquidated(position_id.clone()), &true);

        // 7. Clean up escrow
        env.storage().persistent().remove(&DataKey::KeeperEscrow(position_id));

        // TODO: In production, transfer collateral SAC tokens to receiver
        // For now, the position is marked as liquidated and the receiver is recorded.
        let _ = receiver;

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
        env.ledger().timestamp() > last_heartbeat + grace
    }

    /// Check if a position has been liquidated
    pub fn is_liquidated(env: Env, position_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Liquidated(position_id))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&pm, &verifier, &3600u64);
    }

    #[test]
    fn test_double_init_fails() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&pm, &verifier, &3600u64);

        // Second init should fail
        let result = client.try_initialize(&pm, &verifier, &3600u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_heartbeat() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&pm, &verifier, &3600u64);

        let position_id = BytesN::from_array(&env, &[1u8; 32]);
        client.register_heartbeat(&position_id, &1000u64);

        // Position should not be stale (timestamp is recent)
        assert!(!client.is_stale(&position_id));
    }

    #[test]
    fn test_is_stale_without_heartbeat() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&pm, &verifier, &3600u64);

        // Advance ledger timestamp past grace period (3600s)
        env.ledger().with_mut(|li| {
            li.timestamp = 7200; // Well past grace period for a heartbeat at t=0
        });

        let position_id = BytesN::from_array(&env, &[2u8; 32]);
        // No heartbeat registered — defaults to 0, which is stale at t=7200
        assert!(client.is_stale(&position_id));
    }

    #[test]
    fn test_initiate_liquidation_not_stale_fails() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        // Grace period of 3600 seconds
        client.initialize(&pm, &verifier, &3600u64);

        let position_id = BytesN::from_array(&env, &[3u8; 32]);
        // Register a heartbeat at the current ledger timestamp
        let now = env.ledger().timestamp();
        client.register_heartbeat(&position_id, &now);

        // Try to liquidate — should fail because it's not stale yet
        let keeper_commitment = BytesN::from_array(&env, &[99u8; 32]);
        let result = client.try_initiate_liquidation(&position_id, &keeper_commitment);
        assert!(result.is_err());
    }

    #[test]
    fn test_is_liquidated_default_false() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&pm, &verifier, &3600u64);

        let position_id = BytesN::from_array(&env, &[4u8; 32]);
        assert!(!client.is_liquidated(&position_id));
    }
}
