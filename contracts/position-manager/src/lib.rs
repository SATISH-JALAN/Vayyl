#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env,
};

/// Position state — directional model (not CDP/lending)
#[contracttype]
#[derive(Clone, Debug)]
pub struct PositionState {
    /// Poseidon2 commitment hiding position details
    pub commitment: BytesN<32>,
    /// Owner's public key hash (for heartbeat verification)
    pub owner_hash: BytesN<32>,
    /// Whether position is active
    pub active: bool,
    /// Timestamp of last health attestation
    pub last_attestation: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Verifier,
    LiquidationEngine,
    Position(BytesN<32>),
    PositionNullifier(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    PositionNotFound = 3,
    PositionAlreadyExists = 4,
    ProofFailed = 5,
    NullifierSpent = 6,
}

#[contract]
pub struct PositionManagerContract;

#[contractimpl]
impl PositionManagerContract {
    pub fn initialize(env: Env, verifier: Address, liquidation_engine: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::LiquidationEngine, &liquidation_engine);
        Ok(())
    }

    /// Open a new private position
    pub fn open_position(
        env: Env,
        position_id: BytesN<32>,
        _proof: BytesN<256>,
        commitment: BytesN<32>,
    ) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::Position(position_id.clone())) {
            return Err(Error::PositionAlreadyExists);
        }

        // TODO: Verify PositionOpen proof via Groth16Verifier

        let state = PositionState {
            commitment,
            owner_hash: BytesN::from_array(&env, &[0u8; 32]),
            active: true,
            last_attestation: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Position(position_id), &state);
        // TODO: Register heartbeat with LiquidationEngine
        Ok(())
    }

    /// Attest position health against oracle price
    pub fn attest_health(
        env: Env,
        position_id: BytesN<32>,
        _proof: BytesN<256>,
        _oracle_price: i128,
        _oracle_timestamp: u64,
    ) -> Result<bool, Error> {
        let mut state: PositionState = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id.clone()))
            .ok_or(Error::PositionNotFound)?;

        // TODO: Verify PositionHealthAttestation proof
        // TODO: Verify oracle price staleness

        state.last_attestation = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Position(position_id), &state);
        Ok(true)
    }

    /// Close or modify a position
    pub fn close_or_modify_position(
        env: Env,
        position_id: BytesN<32>,
        _proof: BytesN<256>,
        new_commitment: Option<BytesN<32>>,
        _refund_recipient: Option<Address>,
    ) -> Result<(), Error> {
        let mut state: PositionState = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id.clone()))
            .ok_or(Error::PositionNotFound)?;

        // TODO: Verify PositionCloseOrModify proof

        match new_commitment {
            Some(new_comm) => {
                // Modify: update commitment
                state.commitment = new_comm;
                env.storage().persistent().set(&DataKey::Position(position_id), &state);
            }
            None => {
                // Close: deactivate
                state.active = false;
                env.storage().persistent().set(&DataKey::Position(position_id), &state);
            }
        }
        Ok(())
    }

    pub fn get_position_state(env: Env, position_id: BytesN<32>) -> Result<PositionState, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(Error::PositionNotFound)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(PositionManagerContract, ());
        let client = PositionManagerContractClient::new(&env, &contract_id);

        let verifier = Address::generate(&env);
        let liq_engine = Address::generate(&env);
        client.initialize(&verifier, &liq_engine);
    }
}
